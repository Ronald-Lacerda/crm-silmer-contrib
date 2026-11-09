import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockConversationShipping } from './support/conversation-shipping-mock.js';
import { ownConfirmedOrder } from './support/orders-mock.js';

/** BFUI-01–06: real application components, authenticated HTTP fixture only.
 * @param {import('@playwright/test').Page} page @param {any} [options] */
async function setup(page, options = {}) {
  const shell = await mockConversationShipping(page, {
    multiple: true,
    owner: options.owner,
  });
  if (options.noDirectOrder)
    /** @type {any} */ (shell.conversations[0]).order = null;
  if (options.emptySubjects)
    await page.route(
      /\/api\/v1\/inbox\/conversations\/[^/]+\/subjects(?:\?.*)?$/u,
      (route) =>
        route.fulfill({
          json: {
            currentSubjectId: null,
            subjects: [],
            orders: [],
            links: [],
            needsSubjectMessageIds: [],
            ordersHasMore: false,
          },
        }),
    );
  const order = {
    ...ownConfirmedOrder,
    id: 'shipping-order-1',
    number: '01-CRM',
    conversationId: 'shipping-conversation-1',
    paidOn: null,
    finalAmountCents: 100000,
    seller: { id: 'shipping-seller', name: 'Vendedora sintética' },
  };
  const billing = {
    enabled: true,
    chatSendEnabled: true,
    paymentCheckEnabled: true,
    canManage: true,
    managed: false,
    version: 0,
    orderVersion: order.version,
    percent: null,
    totalAmountCents: 100000,
    receivedAmountCents: 0,
    balanceAmountCents: 100000,
    blockedReason: null,
    reviewRequired: false,
    charges: [],
    externalReceipts: [],
    payments: [],
    paymentChecks: [],
    ...options.billing,
  };
  /** @type {any[]} */ const history = [];
  const intents = new Map();
  const committed = new Map();
  /** @type {any[]} */ const calls = [];
  let lost = false;
  let next = 1;
  page.on('pageerror', (cause) => {
    throw cause;
  });
  /** @param {string} kind @param {number} amountCents @param {any} [extra] */
  function event(kind, amountCents, extra = {}) {
    history.unshift({
      id: `event-${next++}`,
      kind,
      amountCents,
      status: kind === 'receipt' ? 'paid' : 'queued',
      chargeId: null,
      intentId: null,
      occurredAt: new Date().toISOString(),
      ...extra,
    });
  }
  /** @param {number} amountCents @param {string} [source] */
  function receive(amountCents, source = 'infinitepay') {
    const payment = {
      id: `payment-${next++}`,
      source,
      amountCents,
      appliedAmountCents: amountCents,
      refundedAmountCents: 0,
      method: source === 'external' ? 'cash' : 'pix',
      installments: 1,
      receivedOn: '2026-11-08',
      recordedAt: new Date().toISOString(),
      recordedBy: 'shipping-seller',
      recordedByName: 'Vendedora sintética',
      active: true,
      chargeId: billing.charges.at(-1)?.id ?? null,
    };
    billing.payments.push(payment);
    billing.receivedAmountCents += amountCents;
    billing.balanceAmountCents -= amountCents;
    billing.version++;
    if (source === 'infinitepay' && billing.charges.length)
      billing.charges.at(-1).status = 'paid';
    event(source === 'external' ? 'external_receipt' : 'receipt', amountCents, {
      status: 'paid',
    });
    return payment;
  }
  await page.route('**/api/v1/orders/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (/** @type {any} */ body, status = 200) =>
      route.fulfill({ json: body, status });
    if (path === '/api/v1/orders/shipping-order-1') return json({ order });
    if (path === '/api/v1/orders/shipping-order-2')
      return json({
        order: { ...order, id: 'shipping-order-2', number: '02-CRM' },
      });
    if (path.endsWith('/files')) return json({ files: [], quota: {} });
    if (!path.includes('/billing')) return json({}, 404);
    if (req.method() === 'GET') {
      if (path.endsWith('/history'))
        return json({
          orderId: order.id,
          orderVersion: order.version,
          billingVersion: billing.version,
          totalAmountCents: 100000,
          receivedAmountCents: billing.receivedAmountCents,
          balanceAmountCents: billing.balanceAmountCents,
          items: history,
          nextCursor: null,
        });
      if (path.includes('/send-intents/'))
        return json(intents.get(path.split('/').at(-1)) ?? {}, 200);
      return json({ billing });
    }
    const body = req.postDataJSON();
    const key = req.headers()['idempotency-key'];
    calls.push({ path, body, key, csrf: req.headers()['x-csrf-token'] });
    expect(key).toBeTruthy();
    expect(req.headers()['x-csrf-token']).toBeTruthy();
    if (options.conflictOnce && calls.length === 1) {
      billing.version = 4;
      order.version = 5;
      billing.orderVersion = 5;
      shell.conversations[0].version = 7;
      return json({ code: 'VERSION_CONFLICT' }, 409);
    }
    if (committed.has(key)) return json(committed.get(key));
    if (options.failure)
      return json({ code: options.failure.code }, options.failure.status);
    if (path.endsWith('/send-intents')) {
      const amountCents =
        body.action === 'balance'
          ? billing.balanceAmountCents
          : body.action === 'correct'
            ? body.amountCents
            : body.action === 'send_existing'
              ? billing.charges.find(
                  (/** @type {any} */ item) => item.id === body.chargeId,
                ).amountCents
              : body.action === 'retry'
                ? intents.get(body.intentId).amountCents
                : Math.round((100000 * body.percent) / 100);
      const charge = ['send_existing', 'retry'].includes(body.action)
        ? billing.charges.at(-1)
        : {
            id: `charge-${next++}`,
            kind: body.action === 'balance' ? 'balance' : 'signal',
            status: 'waiting',
            amountCents,
            validUntil: new Date(Date.now() + 86400000).toISOString(),
            checkoutUrl: `https://checkout.infinitepay.io/synthetic-${next}`,
            receiptUrl: null,
          };
      if (!billing.charges.includes(charge)) billing.charges.push(charge);
      billing.managed = true;
      billing.version++;
      billing.percent = body.percent ?? billing.percent;
      const intent = {
        id: `intent-${next++}`,
        version: 1,
        action: body.action,
        chargeId: charge.id,
        conversationId: body.conversationId,
        state: 'queued',
        canRetry: false,
        amountCents,
        supersedesChargeId: body.action === 'correct' ? body.chargeId : null,
        retryOfIntentId: body.intentId ?? null,
      };
      intents.set(intent.id, intent);
      event(body.action === 'correct' ? 'correction' : 'intent', amountCents, {
        intentId: intent.id,
        chargeId: charge.id,
        supersedesChargeId: intent.supersedesChargeId,
        retryOfIntentId: intent.retryOfIntentId,
      });
      committed.set(key, intent);
      if (options.loseResponse && !lost) {
        lost = true;
        return route.abort('failed');
      }
      return json(intent, 202);
    }
    if (path.endsWith('/external-receipts')) {
      const payment = receive(body.amountCents, 'external');
      payment.method = body.method;
      payment.receivedOn = body.receivedOn;
      billing.externalReceipts.push({
        ...payment,
        note: body.note,
        reversedAt: null,
      });
    } else if (path.endsWith('/reverse')) {
      const id = path.split('/').at(-2);
      const receipt = billing.payments.find(
        (/** @type {any} */ item) => item.id === id,
      );
      receipt.active = false;
      const original = billing.externalReceipts.find(
        (/** @type {any} */ item) => item.id === id,
      );
      if (original) {
        original.reversedAt = new Date().toISOString();
        original.reversedByName = 'Vendedora sintética';
        original.reversalReason = body.reason;
      }
      billing.receivedAmountCents -= receipt.amountCents;
      billing.balanceAmountCents += receipt.amountCents;
      billing.version++;
      event('external_reversal', receipt.amountCents, { status: 'review' });
    } else if (path.endsWith('/check-payment')) {
      billing.paymentChecks.unshift({
        id: 'check-1',
        state: 'queued',
        chargeId: path.split('/').at(-2),
      });
      return json({ checkId: 'check-1', state: 'queued' }, 202);
    } else if (path.endsWith('/reconcile')) {
      billing.charges
        .filter((/** @type {any} */ item) => item.status === 'waiting')
        .forEach((/** @type {any} */ item) => {
          item.status = 'closed';
        });
      billing.version++;
    }
    committed.set(key, { billing });
    return json({ billing });
  });
  return { ...shell, order, billing, history, intents, calls, receive };
}
/** @param {import('@playwright/test').Page} page */
async function openChat(page) {
  await page.goto('/inbox/shipping-conversation-1');
  await page
    .getByRole('textbox', { name: 'Responder', exact: true })
    .fill('Rascunho preservado');
  const trigger = page.getByRole('button', {
    name: 'Cobranças e pagamentos',
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', {
    name: 'Cobranças e pagamentos',
    exact: true,
  });
  await expect(dialog.getByLabel('Pedido deste atendimento')).toHaveValue('');
  await dialog
    .getByLabel('Pedido deste atendimento')
    .selectOption('shipping-order-1');
  await expect(
    dialog.getByRole('button', {
      name: 'Gerar e enviar cobrança',
      exact: true,
    }),
  ).toBeVisible();
  return { dialog, trigger };
}
/** @param {import('@playwright/test').Page} page @param {import('@playwright/test').Locator} workspace */
async function sendSignal(page, workspace) {
  await workspace
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await review.getByLabel('Percentual de entrada').fill('30');
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await expect(review).toContainText('R$ 300,00');
  await expect(review).toContainText('Cliente sintético 1');
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  await expect(review).not.toBeVisible();
}

test('BFUI-01/02: chat reviews an explicit order and destination, queues one signal without replacing the draft', async ({
  page,
}) => {
  const state = await setup(page);
  const { dialog, trigger } = await openChat(page);
  await sendSignal(page, dialog);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].body).toEqual({
    action: 'issue',
    conversationId: 'shipping-conversation-1',
    expectedVersion: state.order.version,
    expectedBillingVersion: 0,
    expectedConversationVersion: 4,
    percent: 30,
  });
  await expect(dialog).toContainText('Solicitação registrada: Na fila');
  await expect(
    dialog.getByText(/^Solicitação registrada: Na fila/u),
  ).toBeFocused();
  await expect(dialog).toContainText('R$ 0,00');
  await dialog
    .getByRole('button', { name: 'Fechar cobranças', exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toHaveValue('Rascunho preservado');
});

test('BFUI-01/02: direct conversation order remains selectable without a subject and sends only after explicit review', async ({
  page,
}) => {
  const state = await setup(page, { emptySubjects: true });
  const { dialog } = await openChat(page);
  await expect(
    dialog.getByLabel('Pedido deste atendimento').getByRole('option', {
      name: 'Pedido 01-CRM · Pedido vinculado à conversa',
    }),
  ).toHaveCount(1);
  await sendSignal(page, dialog);
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0].path).toBe(
    '/api/v1/orders/shipping-order-1/billing/send-intents',
  );
  expect(state.calls[0].body).toMatchObject({
    action: 'issue',
    conversationId: 'shipping-conversation-1',
    percent: 30,
    expectedConversationVersion: 4,
  });
  await dialog
    .getByRole('button', { name: 'Fechar cobranças', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toHaveValue('Rascunho preservado');
});

test('BFUI-01: absent direct order and empty subjects do not invent a billing destination', async ({
  page,
}) => {
  const state = await setup(page, { emptySubjects: true, noDirectOrder: true });
  await page.goto('/inbox/shipping-conversation-1');
  await page
    .getByRole('button', { name: 'Cobranças e pagamentos', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Cobranças e pagamentos',
    exact: true,
  });
  await expect(dialog).toContainText(
    'Vincule um pedido confirmado a um assunto',
  );
  await expect(dialog.getByLabel('Pedido deste atendimento')).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
});

test('BFUI-02/03: partial receipt switches to server-calculated balance and preserves the prior charge', async ({
  page,
}) => {
  const state = await setup(page);
  const { dialog } = await openChat(page);
  await sendSignal(page, dialog);
  state.receive(30000);
  state.billing.payments[0].method = 'credit_card';
  state.billing.payments[0].installments = 3;
  await dialog
    .getByRole('button', { name: 'Atualizar pagamentos', exact: true })
    .click();
  await expect(dialog).toContainText('R$ 700,00');
  await expect(
    dialog.getByRole('region', { name: 'Pagamentos registrados' }),
  ).toContainText('Cartão em 3x');
  await dialog
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await expect(review.getByLabel('O que deseja cobrar?')).toHaveValue(
    'balance',
  );
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await expect(review).toContainText('R$ 700,00');
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  expect(state.calls.at(-1).body.action).toBe('balance');
  expect(state.calls.at(-1).body).not.toHaveProperty('amountCents');
  expect(state.billing.charges).toHaveLength(2);
  await expect(
    dialog.getByRole('link', { name: 'Abrir cobrança' }),
  ).toHaveCount(2);
});

test('BFUI-04/05: external receipt and reversal use reviewed commands and share payment history with the order', async ({
  page,
}) => {
  const state = await setup(page);
  state.receive(30000);
  state.billing.managed = true;
  await page.goto('/pedidos/shipping-order-1#cobrancas');
  const section = page.getByRole('region', { name: 'Cobranças', exact: true });
  await section
    .getByRole('button', { name: 'Registrar recebimento externo', exact: true })
    .click();
  const receipt = page.getByRole('dialog', {
    name: 'Registrar recebimento externo',
    exact: true,
  });
  await receipt.getByLabel('Valor recebido (R$)').fill('700,00');
  await receipt.getByLabel('Data do recebimento').fill('2026-11-08');
  await receipt.getByRole('button', { name: 'Revisar', exact: true }).click();
  await expect(receipt).toContainText('R$ 700,00');
  await receipt
    .getByRole('button', { name: 'Confirmar recebimento externo', exact: true })
    .click();
  await expect(
    section.getByRole('region', { name: 'Pagamentos registrados' }),
  ).toContainText('Recebimento externo');
  await expect(
    section.getByRole('region', { name: 'Pagamentos registrados' }),
  ).toContainText('Vendedora sintética');
  expect(state.billing.receivedAmountCents).toBe(100000);
  expect(state.billing.balanceAmountCents).toBe(0);
  await section
    .getByRole('button', { name: 'Estornar registro', exact: true })
    .click();
  const reversal = page.getByRole('dialog', {
    name: 'Estornar registro de recebimento',
    exact: true,
  });
  await reversal
    .getByLabel('Motivo do estorno do registro')
    .fill('Valor registrado por engano');
  await reversal.getByRole('button', { name: 'Revisar', exact: true }).click();
  await reversal
    .getByRole('button', { name: 'Confirmar estorno do registro', exact: true })
    .click();
  expect(state.billing.balanceAmountCents).toBe(70000);
  expect(state.calls.at(-1).body.reason).toBe('Valor registrado por engano');
  await expect(section).toContainText('Registro estornado');
});

test('BFUI-05: lost POST response recovers the same immutable body/key and never retries automatically', async ({
  page,
}) => {
  const state = await setup(page, { loseResponse: true });
  const { dialog } = await openChat(page);
  await dialog
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await review.getByLabel('Percentual de entrada').fill('30');
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  await expect(review).toContainText('A resposta não foi confirmada');
  expect(state.calls).toHaveLength(1);
  await review
    .getByRole('button', { name: 'Conferir o mesmo registro', exact: true })
    .click();
  await expect(review).not.toBeVisible();
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1].key).toBe(state.calls[0].key);
  expect(state.calls[1].body).toEqual(state.calls[0].body);
  expect(state.billing.charges).toHaveLength(1);
});

test('BFUI-04: payment check sends only provider identifiers and does not invent a receipt', async ({
  page,
}) => {
  const state = await setup(page);
  const { dialog } = await openChat(page);
  await sendSignal(page, dialog);
  await dialog
    .getByRole('button', { name: 'Conferir pagamento', exact: true })
    .click();
  const check = page.getByRole('dialog', {
    name: 'Conferir pagamento na InfinitePay',
    exact: true,
  });
  await check
    .getByLabel('Identificador da fatura (invoice_slug)')
    .fill('synthetic-invoice');
  await check
    .getByLabel('Identificador da transação (transaction_nsu)')
    .fill('synthetic-transaction');
  await check.getByRole('button', { name: 'Revisar', exact: true }).click();
  await check
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  expect(state.calls.at(-1).body).toEqual({
    expectedVersion: state.order.version,
    expectedBillingVersion: 1,
    invoiceSlug: 'synthetic-invoice',
    transactionNsu: 'synthetic-transaction',
  });
  expect(state.billing.payments).toHaveLength(0);
  await expect(dialog).toContainText('Conferência solicitada');
});

test('BFUI-06: chat dialogs support keyboard, 320/390/1440 widths and both themes without a11y violations', async ({
  page,
}) => {
  await setup(page);
  for (const width of [1440, 390, 320])
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme });
      const { dialog, trigger } = await openChat(page);
      await page.evaluate((value) => {
        globalThis.document.documentElement.dataset.theme = value;
      }, theme);
      const results = await new AxeBuilder({ page })
        .include('.conversation-billing-dialog')
        .analyze();
      expect(results.violations).toEqual([]);
      expect(
        await dialog.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);
      const send = dialog.getByRole('button', {
        name: 'Gerar e enviar cobrança',
        exact: true,
      });
      await send.click();
      const review = page.getByRole('dialog', {
        name: 'Gerar e enviar cobrança',
        exact: true,
      });
      await review.getByLabel('Percentual de entrada').fill('30');
      await review
        .getByRole('button', { name: 'Revisar', exact: true })
        .click();
      const inner = await new AxeBuilder({ page })
        .include('.workspace-dialog')
        .analyze();
      expect(inner.violations).toEqual([]);
      expect(
        await review
          .getByRole('button', {
            name: 'Confirmar envio da cobrança',
            exact: true,
          })
          .evaluate((element) =>
            Number.parseFloat(globalThis.getComputedStyle(element).fontSize),
          ),
      ).toBeGreaterThanOrEqual(12);
      expect(
        await review.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);
      if (width === 1440 && theme === 'light')
        await page.screenshot({
          path: 'var/billing-completion-chat-desktop.png',
        });
      if (width === 390 && theme === 'dark')
        await page.screenshot({
          path: 'var/billing-completion-chat-mobile-dark.png',
        });
      await page.keyboard.press('Escape');
      await expect(review).not.toBeVisible();
      await expect(send).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
      await expect(trigger).toBeFocused();
    }
});

test('BFUI-02: valid existing link is reused instead of issuing a second charge', async ({
  page,
}) => {
  const charge = {
    id: 'existing-charge',
    kind: 'signal',
    status: 'waiting',
    amountCents: 30000,
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    checkoutUrl: 'https://checkout.infinitepay.io/synthetic-existing',
  };
  const state = await setup(page, {
    billing: { managed: true, version: 1, percent: 30, charges: [charge] },
  });
  const { dialog } = await openChat(page);
  await dialog
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await expect(review.getByLabel('O que deseja cobrar?')).toHaveValue(
    'send_existing',
  );
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  expect(state.calls[0].body.action).toBe('send_existing');
  expect(state.calls[0].body.chargeId).toBe('existing-charge');
  expect(state.billing.charges).toHaveLength(1);
});

test('BFUI-02/03: expired charge is reviewed and closed before correction; old link remains visible', async ({
  page,
}) => {
  const old = {
    id: 'expired-charge',
    kind: 'signal',
    status: 'waiting',
    amountCents: 30000,
    validUntil: '2026-01-01T10:00:00Z',
    checkoutUrl: 'https://checkout.infinitepay.io/synthetic-expired',
  };
  const state = await setup(page, {
    billing: { managed: true, version: 1, percent: 30, charges: [old] },
  });
  const { dialog } = await openChat(page);
  await dialog
    .getByRole('button', { name: 'Encerrar cobrança vencida', exact: true })
    .click();
  const close = page.getByRole('dialog', {
    name: 'Encerrar cobrança vencida',
    exact: true,
  });
  await close
    .getByLabel('Conferi a ausência de pagamento na InfinitePay.')
    .check();
  await close.getByRole('button', { name: 'Revisar', exact: true }).click();
  await close
    .getByRole('button', { name: 'Confirmar encerramento local', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await review.getByLabel('O que deseja cobrar?').selectOption('correct');
  await review.getByLabel('Novo valor da cobrança (R$)').fill('200,00');
  await review.getByLabel('Combinei o novo valor com o cliente.').check();
  await review
    .getByLabel(
      'Conferi na InfinitePay que a cobrança anterior venceu e foi encerrada sem pagamento.',
    )
    .check();
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await expect(review).toContainText('R$ 200,00');
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  expect(state.calls.at(-1).body).toMatchObject({
    action: 'correct',
    chargeId: 'expired-charge',
    amountCents: 20000,
    confirmedAgreement: true,
    confirmedProviderReview: true,
  });
  await expect(
    dialog.getByRole('link', { name: 'Abrir link anterior para conferência' }),
  ).toHaveAttribute('href', old.checkoutUrl);
  await dialog
    .getByText('Histórico de cobranças, envios e pagamentos', { exact: true })
    .click();
  await expect(dialog).toContainText(
    'Correção da cobrança anterior de R$ 300,00',
  );
});

test('BFUI-02/05: only a server-confirmed before-send failure offers a reviewed retry of the same link', async ({
  page,
}) => {
  const charge = {
    id: 'retry-charge',
    kind: 'signal',
    status: 'waiting',
    amountCents: 30000,
    validUntil: new Date(Date.now() + 86400000).toISOString(),
    checkoutUrl: 'https://checkout.infinitepay.io/synthetic-retry',
  };
  const state = await setup(page, {
    billing: { managed: true, version: 1, percent: 30, charges: [charge] },
  });
  state.intents.set('failed-intent', {
    id: 'failed-intent',
    version: 3,
    state: 'failed',
    canRetry: false,
    amountCents: 30000,
    chargeId: charge.id,
  });
  state.history.push({
    id: 'failed-event',
    kind: 'intent',
    intentId: 'failed-intent',
    chargeId: charge.id,
    amountCents: 30000,
    status: 'failed',
    occurredAt: '2026-11-08T15:00:00Z',
  });
  const { dialog } = await openChat(page);
  await dialog
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await review.getByLabel('O que deseja cobrar?').selectOption('retry');
  await review.getByLabel('Tentativa anterior').selectOption('failed-intent');
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await expect(review).toContainText(
    'não tem confirmação de falha anterior ao envio',
  );
  expect(state.calls).toHaveLength(0);
  state.intents.get('failed-intent').canRetry = true;
  await review.getByLabel('Tentativa anterior').selectOption('');
  await review.getByLabel('Tentativa anterior').selectOption('failed-intent');
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  expect(state.calls[0].body).toMatchObject({
    action: 'retry',
    intentId: 'failed-intent',
    expectedIntentVersion: 3,
  });
  expect(state.billing.charges).toHaveLength(1);
});

test('BFUI-04/05: receive-only rollback permits external receipt and provider checking while integrated sends stay off', async ({
  page,
}) => {
  const state = await setup(page, {
    billing: {
      enabled: false,
      chatSendEnabled: false,
      managed: true,
      charges: [
        {
          id: 'rollback-charge',
          kind: 'signal',
          status: 'waiting',
          amountCents: 30000,
          validUntil: new Date(Date.now() + 86400000).toISOString(),
          checkoutUrl: 'https://checkout.infinitepay.io/synthetic-rollback',
        },
      ],
    },
  });
  await page.goto('/inbox/shipping-conversation-1');
  await page
    .getByRole('button', { name: 'Cobranças e pagamentos', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Cobranças e pagamentos',
    exact: true,
  });
  await dialog
    .getByLabel('Pedido deste atendimento')
    .selectOption('shipping-order-1');
  await expect(
    dialog.getByRole('button', {
      name: 'Gerar e enviar cobrança',
      exact: true,
    }),
  ).toHaveCount(0);
  await dialog
    .getByRole('button', { name: 'Registrar recebimento externo', exact: true })
    .click();
  const external = page.getByRole('dialog', {
    name: 'Registrar recebimento externo',
    exact: true,
  });
  await external.getByLabel('Valor recebido (R$)').fill('100,00');
  await external.getByRole('button', { name: 'Revisar', exact: true }).click();
  await external
    .getByRole('button', { name: 'Confirmar recebimento externo', exact: true })
    .click();
  expect(state.billing.receivedAmountCents).toBe(10000);
  expect(state.calls[0].path).toContain('/external-receipts');
  await expect(
    dialog.getByRole('button', { name: 'Conferir pagamento', exact: true }),
  ).toBeEnabled();
});

test('BFUI-03/04: external partial receipt makes an oversized outstanding link historical and preserves further external registration', async ({
  page,
}) => {
  const state = await setup(page, {
    billing: {
      managed: true,
      percent: 100,
      charges: [
        {
          id: 'old-full-link',
          kind: 'full',
          status: 'waiting',
          amountCents: 100000,
          validUntil: new Date(Date.now() + 86400000).toISOString(),
          checkoutUrl: 'https://checkout.infinitepay.io/synthetic-old-full',
        },
      ],
    },
  });
  state.receive(50000, 'external');
  await page.goto('/pedidos/shipping-order-1#cobrancas');
  const section = page.getByRole('region', { name: 'Cobranças', exact: true });
  await expect(section).toContainText('Link anterior em circulação');
  await expect(section).toContainText(
    'O link não foi cancelado na InfinitePay',
  );
  await expect(
    section.getByRole('button', { name: 'Copiar link', exact: true }),
  ).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: 'Preparar mensagem', exact: true }),
  ).toHaveCount(0);
  await expect(
    section.getByRole('button', {
      name: 'Registrar recebimento externo',
      exact: true,
    }),
  ).toBeEnabled();
  await section
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await expect(review).toContainText('Não gere outro link');
  expect(state.calls).toHaveLength(0);
});

test('BFUI-05: version conflict refreshes order and conversation and requires a new explicit review', async ({
  page,
}) => {
  const state = await setup(page, { conflictOnce: true });
  const { dialog } = await openChat(page);
  await dialog
    .getByRole('button', { name: 'Gerar e enviar cobrança', exact: true })
    .click();
  const review = page.getByRole('dialog', {
    name: 'Gerar e enviar cobrança',
    exact: true,
  });
  await review.getByLabel('Percentual de entrada').fill('30');
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  await expect(review).toContainText(
    'Os dados do pedido ou da conversa mudaram',
  );
  await expect(
    review.getByRole('button', { name: 'Revisar', exact: true }),
  ).toBeVisible();
  expect(state.calls).toHaveLength(1);
  await review.getByRole('button', { name: 'Revisar', exact: true }).click();
  await review
    .getByRole('button', { name: 'Confirmar envio da cobrança', exact: true })
    .click();
  expect(state.calls).toHaveLength(2);
  expect(state.calls[1].body).toMatchObject({
    expectedVersion: 5,
    expectedBillingVersion: 4,
    expectedConversationVersion: 7,
  });
  expect(state.calls[1].key).not.toBe(state.calls[0].key);
});

test('BFUI-04: an unapplied external receipt remains reversible until its own reversal is recorded', async ({
  page,
}) => {
  const state = await setup(page, {
    billing: { managed: true, reviewRequired: true },
  });
  const payment = state.receive(30000, 'external');
  payment.active = false;
  state.billing.externalReceipts.push({
    ...payment,
    applicationValid: false,
    reversedAt: null,
  });
  await page.goto('/pedidos/shipping-order-1#cobrancas');
  const section = page.getByRole('region', { name: 'Cobranças', exact: true });
  await expect(
    section.getByRole('button', { name: 'Estornar registro', exact: true }),
  ).toBeEnabled();
  await section
    .getByRole('button', { name: 'Estornar registro', exact: true })
    .click();
  const reversal = page.getByRole('dialog', {
    name: 'Estornar registro de recebimento',
    exact: true,
  });
  await reversal
    .getByLabel('Motivo do estorno do registro')
    .fill('Registro externo incorreto');
  await reversal.getByRole('button', { name: 'Revisar', exact: true }).click();
  await reversal
    .getByRole('button', { name: 'Confirmar estorno do registro', exact: true })
    .click();
  await expect(
    section.getByRole('button', { name: 'Estornar registro', exact: true }),
  ).toHaveCount(0);
  await expect(section).toContainText(
    'Motivo do estorno: Registro externo incorreto',
  );
});
