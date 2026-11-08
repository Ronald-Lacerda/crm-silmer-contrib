import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { createBillingChatPreview } from '../../docs/prototypes/billing-chat-preview.mjs';

test.describe.configure({ mode: 'serial' });
/** @type {Awaited<ReturnType<typeof createBillingChatPreview>>} */
let preview;
test.beforeAll(async () => {
  preview = await createBillingChatPreview({ port: 0 });
});
test.afterAll(async () => {
  await preview.close();
});
test.beforeEach(async ({ page }) => {
  preview.fixtures.action('scenario', { scenario: 'new' });
  await page.goto(preview.url);
  await page
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .waitFor();
});

/** @param {import('@playwright/test').Page} page */
const dialog = (page) =>
  page.getByRole('dialog', {
    name: /Cobranças do pedido|Revisar cobrança|Corrigir cobrança/,
  });
/** @param {import('@playwright/test').Page} page @param {string} value */
async function scenario(page, value) {
  const select = dialog(page).getByLabel('Cenário', { exact: true });
  if (!(await select.isVisible()))
    await dialog(page)
      .getByText('Controles da avaliação', { exact: true })
      .click();
  await select.selectOption(value);
}

test('REFRESH-02/03: current Inbox opens billing beside shipping, reviews signal and preserves the chat draft', async ({
  page,
}) => {
  const draft = page.getByRole('textbox', { name: 'Responder', exact: true });
  await draft.fill('Rascunho que deve continuar aqui.');
  const trigger = page.getByRole('button', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await expect(
    page.getByRole('button', { name: 'Cotar frete', exact: true }),
  ).toBeVisible();
  await trigger.click();
  await expect(dialog(page)).toContainText('Protótipo local');
  await expect(dialog(page)).toContainText('R$ 360,00');
  await dialog(page)
    .getByRole('button', { name: 'Revisar cobrança', exact: true })
    .click();
  await expect(dialog(page)).toContainText(
    'Cliente de demonstração · conversa atual',
  );
  await expect(dialog(page)).toContainText('R$ 840,00');
  await dialog(page)
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  await expect(
    dialog(page).getByRole('status').filter({ hasText: 'Gerando link' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(draft).toHaveValue('Rascunho que deve continuar aqui.');
  await expect(
    page.getByRole('list', { name: 'Histórico da conversa' }),
  ).toContainText('Pedido 24-CRM — sinal de R$ 360,00', { timeout: 8000 });
  await trigger.click();
  await expect(
    dialog(page).getByRole('status').filter({ hasText: 'Entregue' }),
  ).toBeVisible({ timeout: 8000 });
  await expect(dialog(page)).toContainText('R$ 0,00');
});

test('REFRESH-04: correction keeps old link and computes remaining balance after confirmed payment', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  await scenario(page, 'existing');
  await dialog(page)
    .getByRole('button', { name: 'Corrigir cobrança', exact: true })
    .click();
  await expect(dialog(page).getByRole('alert')).toContainText(
    'ainda está válido',
  );
  await dialog(page)
    .getByRole('button', { name: 'Simular vencimento e encerramento' })
    .click();
  await dialog(page)
    .getByLabel('Novo valor combinado (R$)', { exact: true })
    .fill('240,00');
  await dialog(page)
    .getByRole('checkbox', { name: 'Combinei este novo valor com o cliente.' })
    .check();
  await dialog(page)
    .getByRole('checkbox', { name: /Conferi na InfinitePay/ })
    .check();
  await dialog(page).getByRole('button', { name: 'Revisar correção' }).click();
  await expect(dialog(page)).toContainText(
    'O link anterior permanece no histórico',
  );
  await dialog(page)
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  await expect(
    dialog(page).getByRole('status').filter({ hasText: 'Entregue' }),
  ).toBeVisible({ timeout: 8000 });
  await expect(dialog(page)).toContainText('Cobrança 01 · R$ 360,00');
  await expect(dialog(page)).toContainText('Cobrança 02 · R$ 240,00');
  await expect(dialog(page)).toContainText('Vencida e encerrada');
  const history = dialog(page).locator('.billing-preview-history');
  if ((await history.getAttribute('open')) === null)
    await history.locator('summary').click();
  await expect(
    history.getByText('Cobrança 01 · R$ 360,00', { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByText('Cobrança 02 · R$ 240,00', { exact: true }),
  ).toBeVisible();
  await expect(
    history.getByRole('button', { name: 'Ver link anterior', exact: true }),
  ).toBeVisible();
  await history
    .getByRole('button', { name: 'Ver link anterior', exact: true })
    .click();
  await expect(
    dialog(page)
      .getByRole('status')
      .filter({ hasText: 'Link fictício preservado:' }),
  ).toContainText('/cobranca/1');
  await history
    .getByRole('button', { name: 'Ver link da cobrança', exact: true })
    .click();
  await expect(
    dialog(page)
      .getByRole('status')
      .filter({ hasText: 'Link fictício preservado:' }),
  ).toContainText('/cobranca/2');
  await dialog(page)
    .getByText('Controles da avaliação', { exact: true })
    .click();
  await dialog(page)
    .getByRole('button', { name: 'Simular pagamento confirmado' })
    .click();
  await expect(dialog(page)).toContainText('R$ 960,00');
  await dialog(page)
    .getByRole('button', { name: 'Revisar cobrança', exact: true })
    .click();
  await expect(dialog(page)).toContainText('R$ 960,00');
  await dialog(page)
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  await expect(
    dialog(page).getByRole('status').filter({ hasText: 'Entregue' }),
  ).toBeVisible({ timeout: 8000 });
  await expect(dialog(page)).toContainText('Cobrança 03 · R$ 960,00');
  await dialog(page)
    .getByText('Controles da avaliação', { exact: true })
    .click();
  await dialog(page)
    .getByRole('button', { name: 'Simular pagamento confirmado' })
    .click();
  await expect(dialog(page)).toContainText('Pedido quitado. Não há saldo');
  await expect(
    dialog(page).getByRole('button', { name: 'Revisar cobrança', exact: true }),
  ).toHaveCount(0);
});

test('REFRESH-03/04: zero percent cannot emit; uncertain result has no retry; safe failure reuses the link', async ({
  page,
}) => {
  await page
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  await dialog(page)
    .getByLabel('Sinal combinado (%)', { exact: true })
    .fill('0');
  await expect(
    dialog(page).getByRole('button', { name: 'Revisar cobrança', exact: true }),
  ).toBeDisabled();
  await expect(dialog(page)).toContainText('Sem entrada não gera cobrança');
  await scenario(page, 'unknown');
  await expect(dialog(page)).toContainText('O envio pode ter ocorrido');
  await expect(
    dialog(page).getByRole('button', { name: 'Revisar nova tentativa' }),
  ).toHaveCount(0);
  await scenario(page, 'before-send-failure');
  await dialog(page)
    .getByRole('button', { name: 'Revisar nova tentativa' })
    .click();
  await expect(dialog(page)).toContainText('Nenhuma nova cobrança será criada');
  await dialog(page)
    .getByRole('button', { name: 'Enviar este link na conversa' })
    .click();
  await expect(
    dialog(page).getByRole('status').filter({ hasText: 'Entregue' }),
  ).toBeVisible({ timeout: 8000 });
  await expect(dialog(page)).toContainText('Histórico de cobranças (1)');
});

test('REFRESH-05: phone and desktop themes keep accessible dialog, focus and bounded width', async ({
  page,
}) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const theme of ['Claro', 'Escuro']) {
      if (theme === 'Escuro')
        await page.evaluate(() =>
          globalThis.document.documentElement.setAttribute(
            'data-theme',
            'dark',
          ),
        );
      else
        await page.evaluate(() =>
          globalThis.document.documentElement.setAttribute(
            'data-theme',
            'light',
          ),
        );
      await page
        .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
        .click();
      await expect(
        dialog(page).getByRole('button', {
          name: 'Revisar cobrança',
          exact: true,
        }),
      ).toBeVisible();
      expect(
        await dialog(page).evaluate(
          (node) => node.scrollWidth <= node.clientWidth,
        ),
      ).toBe(true);
      const results = await new AxeBuilder({ page })
        .include('.billing-chat-preview-dialog')
        .analyze();
      expect(results.violations).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(
        page.getByRole('button', {
          name: 'Gerar e enviar cobrança',
          exact: true,
        }),
      ).toBeFocused();
    }
  }
});

test('REFRESH-02: preview rejects real API writes and never forwards unknown endpoints', async ({
  request,
}) => {
  const base = new URL(preview.url).origin;
  const denied = await request.post(
    `${base}/api/v1/orders/real-order/billing/issue`,
    { data: { percent: 100 } },
  );
  expect(denied.status()).toBe(403);
  expect((await denied.json()).code).toBe('PREVIEW_READ_ONLY');
  const unknown = await request.get(`${base}/api/v1/not-implemented`);
  expect(unknown.status()).toBe(404);
});
