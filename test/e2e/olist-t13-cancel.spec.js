import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import {
  confirmedOrder,
  mockOrders,
  ownConfirmedOrder,
  pendingOrder,
} from './support/orders-mock.js';

// OLIST-T13 (RFC 050, ADR 068): "Cancelar pedido" no detalhe do Pedido. Todos
// os dados são sintéticos e o POST /cancel é sempre interceptado: nenhuma
// chamada real, nenhum efeito no Olist/ERP.

const REASON = 'Cliente desistiu do evento';
const TRIGGER = { exact: true, name: 'Cancelar pedido' };
const DIALOG = { name: 'Cancelar o pedido 07-CRM?' };

/**
 * Cada POST de cancelamento que sai do navegador, com a chave idempotente.
 *
 * @param {import('@playwright/test').Page} page
 */
function watchCancels(page) {
  /** @type {Array<{body: any, key: string|undefined}>} */
  const posts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/cancel')) {
      posts.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
    }
  });
  return posts;
}

/**
 * Two animation frames after the network went quiet: a POST the page started
 * asynchronously would have been seen by now, so the count proves absence.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Array<unknown>} posts
 * @param {number} count
 */
async function expectPostCount(page, posts, count) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(() => resolve(null)),
        ),
      ),
  );
  expect(posts).toHaveLength(count);
}

/** @param {import('@playwright/test').Page} page */
async function expectNoOverflow(page) {
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
}

/** @param {import('@playwright/test').Page} page */
async function expectNoAxeViolations(page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

/** @param {import('@playwright/test').Page} page */
function liveRegion(page) {
  return page.locator('p.sr-only[aria-live="polite"]');
}

const adminCapabilities = ['COMMERCIAL_ADMIN'];

test('cancels by keyboard, sends one reason, and lands on Cancelado with one announcement', async ({
  page,
}) => {
  await page.setViewportSize({ height: 900, width: 1366 });
  const posts = watchCancels(page);
  // Records every time the shell live region receives text.
  await page.addInitScript(() => {
    /** @type {string[]} */
    const heard = [];
    Object.defineProperty(globalThis, '__heard', { value: heard });
    globalThis.document.addEventListener('DOMContentLoaded', () => {
      const watch = () => {
        const region = globalThis.document.querySelector(
          'p.sr-only[aria-live="polite"]',
        );
        if (!region) {
          globalThis.requestAnimationFrame(watch);
          return;
        }
        new globalThis.MutationObserver(() => {
          const text = (region.textContent ?? '').trim();
          if (text) heard.push(text);
        }).observe(region, {
          characterData: true,
          childList: true,
          subtree: true,
        });
      };
      watch();
    });
  });
  await mockOrders(page, { orders: [pendingOrder] });
  await page.goto('/pedidos/order-pendente');
  await expect(
    page.getByRole('heading', { name: 'Pedido 07-CRM' }),
  ).toBeFocused();
  await expect(page.locator('.op-status')).toHaveText('Pendente');

  const trigger = page.getByRole('button', TRIGGER);
  await expect(trigger).toHaveAccessibleDescription(
    /Encerra o pedido no CRM.*Não é exclusão nem estorno/u,
  );
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog', DIALOG);
  const reason = dialog.getByLabel('Motivo do cancelamento');
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAttribute('maxlength', '1000');
  await expect(reason).toHaveAttribute('aria-required', 'true');
  // Aviso de impacto: nas vendas, receita, afazeres, filas; não é exclusão,
  // estorno nem cancelamento no ERP; sem aviso de pagamento neste pedido.
  await expect(dialog).toHaveAccessibleDescription(
    /definitivo.*vendas ativas.*receita vendida.*afazeres.*produção e de entrega.*Não é exclusão de dados, não é estorno e nada é cancelado no Olist ou no ERP/su,
  );
  await expect(dialog).not.toContainText('devolve dinheiro');
  await expectNoAxeViolations(page);

  // Sem motivo: nada é enviado, o erro fica ligado ao campo e o foco vai a ele.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(
    dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reason).toBeFocused();
  await expect(reason).toHaveAttribute('aria-invalid', 'true');
  await expect(reason).toHaveAccessibleDescription(
    'Informe o motivo do cancelamento.',
  );
  await expectPostCount(page, posts, 0);

  // Quebra de linha vira espaço: o servidor recusa caractere de controle.
  await reason.fill(`  Cliente desistiu\ndo evento  `);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');

  await expect(dialog).toHaveCount(0);
  await expectPostCount(page, posts, 1);
  expect(posts[0].key).toBeTruthy();
  expect(posts[0].body).toEqual({ expectedVersion: 2, reason: REASON });

  // Estado Cancelado, terminal: foco no estado, um único anúncio.
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expect(
    page.getByRole('heading', { name: 'Cancelado no CRM' }),
  ).toBeFocused();
  await expect(liveRegion(page)).toHaveText('Pedido 07-CRM cancelado.');
  // The visible toast carries the text but is not a live region, and the live
  // region received it exactly once.
  await expect(
    page.locator('.notice-toast-region .notice-toast-message'),
  ).toHaveText('Pedido 07-CRM cancelado.');
  await expect(
    page.locator(
      '.notice-toast-region [aria-live], .notice-toast-region [role="status"], .notice-toast-region [role="alert"]',
    ),
  ).toHaveCount(0);
  await expect(
    page
      .locator('[aria-live], [role="status"], [role="alert"]')
      .filter({ hasText: 'Pedido 07-CRM cancelado.' }),
  ).toHaveCount(1);
  await page.waitForLoadState('networkidle');
  expect(
    await page.evaluate(() =>
      /** @type {string[]} */ (/** @type {any} */ (globalThis).__heard).filter(
        (text) => text === 'Pedido 07-CRM cancelado.',
      ),
    ),
  ).toHaveLength(1);
  await expect(page.getByRole('button', TRIGGER)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Reabrir|Restaurar/u }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Pedido cancelado. A edição e a geração estão bloqueadas.'),
  ).toBeVisible();
  const facts = page.getByRole('region', { name: 'Cancelado no CRM' });
  await expect(facts).toContainText('Marina Aguiar');
  await expect(facts).toContainText(REASON);
  await expect(facts).toContainText('nada foi alterado no Olist');
  await expectNoAxeViolations(page);

  // Recarregar mantém o que o servidor guardou.
  await page.reload();
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expectPostCount(page, posts, 1);
});

test('Esc and Voltar close without sending and give the focus back to the button', async ({
  page,
}) => {
  const posts = watchCancels(page);
  await mockOrders(page, { orders: [pendingOrder] });
  await page.goto('/pedidos/order-pendente');

  const trigger = page.getByRole('button', TRIGGER);
  await trigger.click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // O texto não sobrevive a um recuo comum.
  await trigger.click();
  await expect(dialog.getByLabel('Motivo do cancelamento')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Voltar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expectPostCount(page, posts, 0);
  await expect(page.locator('.op-status')).toHaveText('Pendente');
});

test('a double click sends one cancellation', async ({ page }) => {
  const posts = watchCancels(page);
  await mockOrders(page, { orders: [pendingOrder] });
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route('**/api/v1/orders/*/cancel', async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto('/pedidos/order-pendente');

  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  const submit = dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' });
  await submit.dblclick();
  await expect(
    dialog.getByRole('button', { name: 'Cancelando…' }),
  ).toHaveAttribute('aria-disabled', 'true');
  // Esc espera a resposta de um envio já feito.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  release();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expectPostCount(page, posts, 1);
});

test('a version conflict keeps the typed reason, sends nothing over the new version and asks to review', async ({
  page,
}) => {
  const posts = watchCancels(page);
  let details = 0;
  await mockOrders(page, {
    onDetail: () => {
      details += 1;
    },
    orders: [pendingOrder],
    writeFailure: {
      body: { code: 'VERSION_CONFLICT' },
      persist: { version: 3 },
      status: 409,
    },
  });
  await page.goto('/pedidos/order-pendente');

  const trigger = page.getByRole('button', TRIGGER);
  await trigger.click();
  const dialog = page.getByRole('dialog', DIALOG);
  const reason = dialog.getByLabel('Motivo do cancelamento');
  await reason.fill(REASON);
  const submit = dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' });
  await submit.click();

  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('Este pedido mudou');
  await expect(alert).toContainText('o motivo digitado será mantido');
  await expect(alert).toBeFocused();
  await expect(reason).toHaveValue(REASON);
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  await expect(page.locator('body')).not.toContainText('VERSION_CONFLICT');
  // O estado persistido é relido, sem trocar a versão em silêncio.
  await expect.poll(() => details).toBeGreaterThanOrEqual(2);
  await submit.click({ force: true });
  await expectPostCount(page, posts, 1);
  expect(posts[0].body.expectedVersion).toBe(2);

  // Rever e abrir de novo: o texto continua e a versão nova é a capturada.
  await dialog.getByRole('button', { name: 'Voltar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(reason).toHaveValue(REASON);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expectPostCount(page, posts, 2);
  expect(posts[1].body).toEqual({ expectedVersion: 3, reason: REASON });
  expect(posts[1].key).not.toBe(posts[0].key);
});

test('a Olist lock that wins the race is explained in Portuguese and the persisted state is read again, with no retry', async ({
  page,
}) => {
  const posts = watchCancels(page);
  let details = 0;
  await mockOrders(page, {
    onDetail: () => {
      details += 1;
    },
    orders: [pendingOrder],
    writeFailure: {
      body: { code: 'ORDER_CANCELLATION_BLOCKED' },
      persist: { olistLocked: true, version: 3 },
      status: 409,
    },
  });
  await page.goto('/pedidos/order-pendente');

  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }).click();

  await expect(dialog).toHaveCount(0);
  const alert = page.getByRole('alert').filter({ hasText: 'venda reservada' });
  await expect(alert).toContainText('não pode ser cancelado aqui');
  await expect(alert).toBeFocused();
  await expect(page.locator('body')).not.toContainText(
    'ORDER_CANCELLATION_BLOCKED',
  );
  await expect.poll(() => details).toBeGreaterThanOrEqual(2);
  await expect(
    page.getByText('A composição não pode ser editada, reaberta ou cancelada.'),
  ).toBeVisible();
  await expect(page.getByRole('button', TRIGGER)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Tentar novamente/u }),
  ).toHaveCount(0);
  await expectPostCount(page, posts, 1);
});

test('an order cancelled elsewhere is reported and shown as Cancelado', async ({
  page,
}) => {
  await mockOrders(page, {
    orders: [pendingOrder],
    writeFailure: {
      body: { code: 'ORDER_CANCELLED' },
      persist: {
        cancelledAt: '2026-11-08T14:00:00.000Z',
        cancelledBy: { id: 'seller-ricardo', name: 'Ricardo Lima' },
        effectiveStatus: 'cancelado',
        version: 3,
      },
      status: 409,
    },
  });
  await page.goto('/pedidos/order-pendente');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }).click();

  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: 'já foi cancelado' }),
  ).toBeFocused();
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expect(
    page.getByRole('region', { name: 'Cancelado no CRM' }),
  ).toContainText('Ricardo Lima');
  await expect(page.locator('body')).not.toContainText('ORDER_CANCELLED');
});

test('a 403 keeps the dialog and the typed reason and asks to check the session, without claiming a lack of permission', async ({
  page,
}) => {
  const posts = watchCancels(page);
  let details = 0;
  await mockOrders(page, {
    onDetail: () => {
      details += 1;
    },
    orders: [pendingOrder],
    writeFailure: {
      body: { code: 'FORBIDDEN', detail: 'raw-server-detail-canary' },
      status: 403,
    },
  });
  await page.goto('/pedidos/order-pendente');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  const reason = dialog.getByLabel('Motivo do cancelamento');
  await reason.fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }).click();

  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('sua sessão pode ter expirado');
  await expect(alert).toContainText('O motivo foi mantido');
  await expect(alert).not.toContainText('Você não pode cancelar');
  await expect(alert).toBeFocused();
  await expect(dialog).toBeVisible();
  await expect(reason).toHaveValue(REASON);
  await expect(page.locator('body')).not.toContainText('raw-server-detail');
  // The persisted order is read again; nothing else is sent.
  await expect.poll(() => details).toBeGreaterThanOrEqual(2);
  await expectPostCount(page, posts, 1);
});

test('a 200 without the cancelled order is an uncertain result: the dialog closes, the order is read again and nothing throws', async ({
  page,
}) => {
  const posts = watchCancels(page);
  /** @type {string[]} */
  const failures = [];
  page.on('pageerror', (error) => failures.push(String(error)));
  let details = 0;
  await mockOrders(page, {
    onDetail: () => {
      details += 1;
    },
    orders: [pendingOrder],
  });
  await page.route('**/api/v1/orders/*/cancel', (route) =>
    route.fulfill({
      body: JSON.stringify({}),
      contentType: 'application/json',
      status: 200,
    }),
  );
  await page.goto('/pedidos/order-pendente');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }).click();

  await expect(dialog).toHaveCount(0);
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'sem confirmar o cancelamento' });
  await expect(alert).toBeFocused();
  await expect(alert).toContainText('Não sabemos se o pedido foi cancelado');
  await expect.poll(() => details).toBeGreaterThanOrEqual(2);
  // The persisted state still says Pendente, and the action is offered again.
  await expect(page.locator('.op-status')).toHaveText('Pendente');
  await expect(page.getByRole('button', TRIGGER)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Cancelado no CRM' }),
  ).toHaveCount(0);
  await expectPostCount(page, posts, 1);
  expect(failures).toEqual([]);
});

test('a 204 without a body is also an uncertain result, with no silent error', async ({
  page,
}) => {
  /** @type {string[]} */
  const failures = [];
  page.on('pageerror', (error) => failures.push(String(error)));
  await mockOrders(page, { orders: [pendingOrder] });
  await page.route('**/api/v1/orders/*/cancel', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.goto('/pedidos/order-pendente');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: 'sem confirmar o cancelamento' }),
  ).toBeFocused();
  expect(failures).toEqual([]);
});

test('the dialog warns that the reason is shown to whoever reads the order and must carry no personal data', async ({
  page,
}) => {
  await mockOrders(page, { orders: [pendingOrder] });
  await page.goto('/pedidos/order-pendente');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  const reason = dialog.getByLabel('Motivo do cancelamento');
  await expect(reason).toHaveAccessibleDescription(
    /aparece para quem consulta o pedido.*Não inclua dados pessoais do cliente/su,
  );
});

test('an unavailable service keeps the dialog and retries the very same command', async ({
  page,
}) => {
  const posts = watchCancels(page);
  await mockOrders(page, {
    orders: [pendingOrder],
    writeFailure: { body: { code: 'UNAVAILABLE' }, status: 503 },
  });
  await page.goto('/pedidos/order-pendente');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', DIALOG);
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  const submit = dialog.getByRole('button', { name: 'Cancelar pedido 07-CRM' });
  await submit.click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Não sabemos se o cancelamento foi registrado',
  );
  await expect(dialog.getByLabel('Motivo do cancelamento')).toHaveValue(REASON);
  await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
  await submit.click();
  await expect.poll(() => posts.length).toBe(2);
  // Resultado incerto: a mesma chave e o mesmo corpo, para o servidor devolver
  // o recibo em vez de cancelar duas vezes.
  expect(posts[1]).toEqual(posts[0]);
});

test('offers no cancellation to a locked order, to a reader without commercial access or to a cancelled order', async ({
  page,
}) => {
  await mockOrders(page, {
    orders: [
      { ...ownConfirmedOrder, id: 'order-travado', olistLocked: true },
      { ...confirmedOrder, id: 'order-outro-dono' },
      {
        ...pendingOrder,
        cancelledAt: '2026-11-08T14:00:00.000Z',
        cancelledBy: { id: 'seller-marina', name: 'Marina Aguiar' },
        cancellationReason: 'Pedido duplicado',
        effectiveStatus: 'cancelado',
        id: 'order-cancelado',
        version: 5,
      },
      ownConfirmedOrder,
    ],
  });

  // Enviado/vinculado/reservado/incerto: nem Cancelar nem Reabrir.
  await page.goto('/pedidos/order-travado');
  await expect(page.locator('.op-status')).toHaveText('Confirmado');
  await expect(
    page.getByText('A composição não pode ser editada, reaberta ou cancelada.'),
  ).toBeVisible();
  await expect(page.getByRole('button', TRIGGER)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Reabrir pedido/u }),
  ).toHaveCount(0);
  await expect(page.locator('.op-cancel')).toHaveCount(0);

  // Quem só lê (outro responsável) não vê a ação, e nenhum botão de escrita.
  await page.goto('/pedidos/order-outro-dono');
  await expect(page.getByText('Somente Ricardo Lima ou um')).toBeVisible();
  await expect(page.getByRole('button', TRIGGER)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Reabrir pedido/u }),
  ).toHaveCount(0);

  // Cancelado é terminal: sem Cancelar, sem Reabrir, com o motivo guardado.
  await page.goto('/pedidos/order-cancelado');
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expect(page.getByRole('button', TRIGGER)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Reabrir pedido|Restaurar/u }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Cancelado no CRM' }),
  ).toContainText('Pedido duplicado');
  await expectNoAxeViolations(page);

  // Controle positivo: o responsável por um pedido livre da trava vê as duas.
  await page.goto('/pedidos/order-confirmado');
  await expect(page.getByRole('button', TRIGGER)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Reabrir pedido' }),
  ).toBeVisible();
});

test('a paid order and a store order add the no-refund notice; a store order needs an administrator', async ({
  page,
}) => {
  const storeOrder = {
    ...ownConfirmedOrder,
    gatewayPayment: {
      confirmedAt: '2026-10-08T02:15:55.000Z',
      invoiceSlug: 'fatura-sintetica-1',
      paidAmountCents: 18000,
      source: 'infinitepay',
      transactionNsu: 'nsu-sintetico-0001',
    },
    id: 'order-loja',
    locked: true,
    number: '12-CRM',
    origin: 'loja',
    paidOn: null,
    seller: null,
    storeNumber: 'LJ-0001',
  };
  await mockOrders(page, { orders: [ownConfirmedOrder, storeOrder] });

  // Pago: o aviso extra entra na descrição do diálogo.
  await page.goto('/pedidos/order-confirmado');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', {
    name: 'Cancelar o pedido 05-CRM?',
  });
  await expect(dialog).toContainText(
    'Cancelar aqui não devolve dinheiro e não altera o gateway de pagamento nem o checkout',
  );
  await expect(dialog).toHaveAccessibleDescription(/não devolve dinheiro/u);
  await expectNoAxeViolations(page);
  await page.keyboard.press('Escape');

  // Loja, sem ser administrador: sem ação.
  await page.goto('/pedidos/order-loja');
  await expect(page.getByText('Loja · LJ-0001')).toBeVisible();
  await expect(page.getByRole('button', TRIGGER)).toHaveCount(0);
});

test('a store order offers the cancellation to an administrator, with the notice', async ({
  page,
}) => {
  const posts = watchCancels(page);
  await mockOrders(page, {
    orders: [
      {
        ...ownConfirmedOrder,
        gatewayPayment: {
          confirmedAt: '2026-10-08T02:15:55.000Z',
          invoiceSlug: 'fatura-sintetica-1',
          paidAmountCents: 18000,
          source: 'infinitepay',
          transactionNsu: 'nsu-sintetico-0001',
        },
        id: 'order-loja',
        locked: true,
        number: '12-CRM',
        origin: 'loja',
        paidOn: null,
        seller: null,
        storeNumber: 'LJ-0001',
      },
    ],
    user: { capabilities: adminCapabilities, id: 'admin-synthetic' },
  });
  await page.goto('/pedidos/order-loja');
  await page.getByRole('button', TRIGGER).click();
  const dialog = page.getByRole('dialog', {
    name: 'Cancelar o pedido 12-CRM?',
  });
  await expect(dialog).toContainText('não devolve dinheiro');
  await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
  await dialog.getByRole('button', { name: 'Cancelar pedido 12-CRM' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expectPostCount(page, posts, 1);
});

for (const viewport of [
  { height: 700, width: 320 },
  { height: 844, width: 390 },
  { height: 900, width: 1366 },
]) {
  test(`the dialog and the cancelled state have no axe violation or overflow at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await mockOrders(page, { orders: [pendingOrder] });
    await page.goto('/pedidos/order-pendente');
    await expectNoOverflow(page);

    // No celular a ação está na seção, abaixo do pedido; o teclado a alcança.
    const trigger = page.getByRole('button', TRIGGER);
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const dialog = page.getByRole('dialog', DIALOG);
    await expect(dialog).toBeVisible();
    await expectNoOverflow(page);
    const box = await dialog.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      viewport.width,
    );
    for (const name of ['Voltar', 'Cancelar pedido 07-CRM']) {
      const target = await dialog.getByRole('button', { name }).boundingBox();
      expect(target?.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoAxeViolations(page);

    await dialog.getByLabel('Motivo do cancelamento').fill(REASON);
    await dialog
      .getByRole('button', { name: 'Cancelar pedido 07-CRM' })
      .click();
    await expect(page.locator('.op-status')).toHaveText('Cancelado');
    await expect(
      page.getByRole('heading', { name: 'Cancelado no CRM' }),
    ).toBeFocused();
    await expectNoOverflow(page);
    await expectNoAxeViolations(page);
  });
}
