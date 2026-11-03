import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

/**
 * INBOX-UX-03 / CP-10: fixtures deliberately separate the canonical header
 * order from a pending order linked only by subject. No real contact data.
 * @param {import('@playwright/test').Page} page
 * @param {{canonicalStatus?: 'confirmado'|'pendente'|null, pending?: boolean, pendingOnFirstClose?: boolean, otherOwner?: boolean}} [options]
 */
async function setupInbox(page, options = {}) {
  let pending = options.pending ?? true;
  const canonicalStatus = options.canonicalStatus ?? null;
  const order = {
    confirmedAt: null,
    conversationId: 'previous-cycle',
    createdAt: '2026-11-03T11:00:00.000Z',
    fabCode: null,
    ficha: {
      items: [{ tipo: 'Camiseta infantil', grade: [] }],
      observations: [],
      serviceData: {},
      summary: { cliente: 'Contato sintético', nome: 'Turma da escola' },
    },
    finalAmountCents: null,
    id: 'order-linked',
    missingFields: ['finalAmount', 'paymentCondition'],
    number: '34-CRM',
    paymentCondition: null,
    seller: { id: 'seller-1', name: 'Vendedor sintético' },
    status: 'pendente',
    totalPieces: 0,
    version: 2,
  };
  const conversation = {
    assignedUser: {
      id: options.otherOwner ? 'seller-other' : 'seller-1',
      functionName: 'Vendedor',
    },
    automationEpoch: 2,
    automationState: 'human',
    channel: 'whatsapp',
    contact: {
      externalId: '5500000000000',
      id: 'contact-compact',
      label: 'Contato sintético',
    },
    handoff: null,
    hasPendingOrder: pending,
    id: 'conversation-compact',
    lastMessage: {
      authorKind: 'contact',
      direction: 'inbound',
      id: 'message-compact',
      occurredAt: '2026-11-03T11:27:00.000Z',
      preview: 'Pode conferir esta referência?',
      status: 'received',
      type: 'text',
    },
    openedAt: '2026-11-03T11:18:00.000Z',
    order: canonicalStatus
      ? { id: 'order-canonical', number: '33-CRM', status: canonicalStatus }
      : null,
    requiresAttention: false,
    state: 'em_atendimento',
    terminalAt: /** @type {string|null} */ (null),
    version: 3,
  };
  const initialOrder = structuredClone(order);
  /** @type {any[]} */
  const closes = [];
  /** @type {string[]} */
  const orderMutations = [];
  /** @type {any[]} */
  const archives = [];
  const messages = [
    conversation.lastMessage,
    {
      authorKind: 'assistant',
      direction: 'outbound',
      id: 'message-ai',
      occurredAt: '2026-11-03T11:25:00.000Z',
      preview: 'Vou organizar os dados do pedido.',
      status: 'sent',
      type: 'text',
    },
    {
      authorKind: 'contact',
      direction: 'inbound',
      id: 'message-image',
      media: {
        contentUrl:
          '/api/v1/conversations/conversation-compact/media/image-compact/content',
        kind: 'image',
        mediaId: 'image-compact',
        state: 'attached',
      },
      occurredAt: '2026-11-03T11:26:00.000Z',
      preview: 'Imagem',
      status: 'received',
      type: 'image',
    },
  ];
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'csrf-compact',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (/^\/api\/v1\/orders\//u.test(path) && method !== 'GET')
      orderMutations.push(path);
    if (path === '/api/v1/sessions/current')
      return route.fulfill({
        json: {
          user: { id: 'seller-1', functionName: 'Vendedor', capabilities: [] },
        },
      });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n: connected\n\n',
      });
    if (path === '/api/v1/users/assignable')
      return route.fulfill({ json: { users: [] } });
    if (path === '/api/v1/inbox/conversations')
      return route.fulfill({
        json: {
          items: conversation.terminalAt ? [] : [conversation],
          totalCount: conversation.terminalAt ? 0 : 1,
          nextCursor: null,
        },
      });
    if (path === '/api/v1/inbox/conversations/conversation-compact/subjects')
      return route.fulfill({
        json: {
          currentSubjectId: 'subject-linked',
          links: [],
          needsSubjectMessageIds: [],
          orders: [order],
          ordersHasMore: false,
          subjects: pending
            ? [
                {
                  id: 'subject-linked',
                  isCurrent: true,
                  kind: 'pedido',
                  orderId: order.id,
                  orderNumber: order.number,
                  orderStatus: order.status,
                  position: 1,
                  selectedSource: 'human',
                  version: 1,
                },
              ]
            : [],
        },
      });
    if (path === '/api/v1/inbox/conversations/conversation-compact')
      return route.fulfill({
        json: { conversation, messages, suggestion: null },
      });
    if (
      path ===
      '/api/v1/conversations/conversation-compact/media/image-compact/content'
    )
      return route.fulfill({
        contentType: 'image/png',
        body: await readFile('test/fixtures/media-composer.png'),
      });
    if (path === '/api/v1/conversations/conversation-compact/order')
      return route.fulfill({
        json: {
          order: canonicalStatus
            ? {
                ...order,
                id: 'order-canonical',
                number: '33-CRM',
                status: canonicalStatus,
              }
            : null,
        },
      });
    if (path === '/api/v1/orders/order-linked')
      return route.fulfill({ json: { order } });
    if (path === '/api/v1/contacts/contact-compact')
      return route.fulfill({
        json: {
          contact: {
            ...conversation.contact,
            version: 1,
            provisional: false,
          },
          conversations: [conversation],
          identities: [],
          orders: [order],
        },
      });
    if (path === '/api/v1/conversations/conversation-compact/close') {
      const body = request.postDataJSON();
      closes.push(body);
      if (options.pendingOnFirstClose && closes.length === 1) {
        // Another command linked the previous cycle's pending order after
        // the user opened the confirmation. The server guard is decisive.
        pending = true;
        conversation.hasPendingOrder = true;
        conversation.version += 1;
        return route.fulfill({ status: 409, json: { code: 'CONFLICT' } });
      }
      if (pending && body.acknowledgePending !== true)
        return route.fulfill({ status: 409, json: { code: 'CONFLICT' } });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.headers()['x-csrf-token']).toBe('csrf-compact');
      conversation.state = 'encerrada';
      conversation.terminalAt = '2026-11-03T12:00:00.000Z';
      conversation.version += 1;
      return route.fulfill({ json: { conversation } });
    }
    if (path === '/api/v1/conversations/conversation-compact/archive') {
      archives.push(request.postDataJSON());
      return route.fulfill({ json: { accepted: true } });
    }
    return route.fulfill({ json: { items: [], totalCount: 0 } });
  });
  return { archives, closes, initialOrder, order, orderMutations };
}

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`INBOX-UX-03: overlays preserve conversation width and keyboard focus at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setupInbox(page);
    await page.goto('/inbox/conversation-compact');
    const conversation = page.locator('.inbox-conversation');
    await expect(conversation).toBeVisible();
    const before = await conversation.boundingBox();
    const details = page.getByRole('button', {
      name: 'Detalhes do atendimento',
      exact: true,
    });
    await details.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog', {
      name: 'Atendimento',
      exact: true,
    });
    await expect(drawer).toBeVisible();
    const after = await conversation.boundingBox();
    expect(after?.width).toBeCloseTo(before?.width ?? 0, 0);
    expect(
      await drawer.evaluate((element) =>
        element.contains(globalThis.document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(details).toBeFocused();

    const name = page.getByRole('button', {
      name: 'Dados de Contato sintético',
      exact: true,
    });
    await name.focus();
    await page.keyboard.press('Enter');
    const profile = page.getByRole('dialog', { name: 'Cadastro', exact: true });
    await expect(profile).toBeVisible();
    await expect(profile).toContainText('Contato sintético');
    expect(
      await profile.evaluate((element) =>
        element.contains(globalThis.document.activeElement),
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(profile).toBeHidden();
    await expect(name).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Enviar resposta', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

for (const canonicalStatus of [null, 'confirmado']) {
  test(`CP-10: pending subject order requires acknowledgement when canonical order is ${canonicalStatus ?? 'absent'}`, async ({
    page,
  }) => {
    const state = await setupInbox(page, {
      canonicalStatus: /** @type {'confirmado'|null} */ (canonicalStatus),
    });
    await page.goto('/inbox/conversation-compact');
    await page.getByRole('button', { name: 'Mais ações', exact: true }).click();
    await page
      .getByRole('button', { name: 'Encerrar conversa', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Encerrar conversa?' });
    const acknowledgement = dialog.getByRole('checkbox', {
      name: /Há um pedido pendente/u,
    });
    await expect(acknowledgement).toBeVisible();
    await expect(acknowledgement).not.toBeChecked();
    await dialog
      .getByRole('button', { name: 'Encerrar conversa', exact: true })
      .click();
    expect(state.closes).toHaveLength(0);
    await expect(dialog).toBeVisible();
    await acknowledgement.check();
    await dialog
      .getByRole('button', { name: 'Encerrar conversa', exact: true })
      .click();
    await expect.poll(() => state.closes.length).toBe(1);
    expect(state.closes[0]).toMatchObject({
      acknowledgePending: true,
      expectedVersion: 3,
      outcome: 'concluido',
    });
    await expect(dialog).toBeHidden();
    expect(state.order).toEqual(state.initialOrder);
    expect(state.orderMutations).toEqual([]);
  });
}

test('CP-10: confirmed-only conversation closes without a pending-order acknowledgement', async ({
  page,
}) => {
  const state = await setupInbox(page, {
    canonicalStatus: 'confirmado',
    pending: false,
  });
  await page.goto('/inbox/conversation-compact');
  await page.getByRole('button', { name: 'Mais ações', exact: true }).click();
  await page
    .getByRole('button', { name: 'Encerrar conversa', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Encerrar conversa?' });
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog
    .getByRole('button', { name: 'Encerrar conversa', exact: true })
    .click();
  await expect.poll(() => state.closes.length).toBe(1);
  expect(state.closes[0].acknowledgePending).toBe(false);
  expect(state.orderMutations).toEqual([]);
});

test('CP-10: a pending order linked during closure requires fresh acknowledgement after 409', async ({
  page,
}) => {
  const state = await setupInbox(page, {
    canonicalStatus: 'confirmado',
    pending: false,
    pendingOnFirstClose: true,
  });
  await page.goto('/inbox/conversation-compact');
  await page.getByRole('button', { name: 'Mais ações', exact: true }).click();
  await page
    .getByRole('button', { name: 'Encerrar conversa', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Encerrar conversa?' });
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog
    .getByRole('button', { name: 'Encerrar conversa', exact: true })
    .click();
  await expect.poll(() => state.closes.length).toBe(1);
  expect(state.closes[0].acknowledgePending).toBe(false);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('alert')).toContainText(
    'A conversa mudou enquanto você trabalhava.',
  );
  const acknowledgement = dialog.getByRole('checkbox', {
    name: /Há um pedido pendente/u,
  });
  await expect(acknowledgement).toBeVisible();
  await expect(acknowledgement).not.toBeChecked();
  // Retrying without deliberate acknowledgement must not reach the API.
  await dialog
    .getByRole('button', { name: 'Encerrar conversa', exact: true })
    .click();
  expect(state.closes).toHaveLength(1);
  await acknowledgement.check();
  await dialog
    .getByRole('button', { name: 'Encerrar conversa', exact: true })
    .click();
  await expect.poll(() => state.closes.length).toBe(2);
  expect(state.closes[1]).toMatchObject({
    acknowledgePending: true,
    expectedVersion: 4,
    outcome: 'concluido',
  });
  await expect(dialog).toBeHidden();
  expect(state.order).toEqual(state.initialOrder);
  expect(state.orderMutations).toEqual([]);
});

test('INBOX-UX-03: image order controls appear only on request and preserve image viewer focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await setupInbox(page, { canonicalStatus: 'pendente' });
  await page.goto('/inbox/conversation-compact');
  const image = page.getByRole('button', {
    name: 'Ampliar imagem',
    exact: true,
  });
  await expect(image).toBeVisible();
  await expect(
    page.getByRole('combobox', {
      name: 'Anexar imagem ao pedido',
      exact: true,
    }),
  ).toHaveCount(0);
  await image.focus();
  await page.keyboard.press('Enter');
  const viewer = page.getByRole('dialog', {
    name: 'Imagem ampliada',
    exact: true,
  });
  await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(image).toBeFocused();
  const attach = page.getByRole('button', {
    name: 'Anexar imagem ao pedido',
    exact: true,
  });
  await attach.click();
  await expect(attach).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('combobox', {
      name: 'Anexar imagem ao pedido',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Anexar ao pedido', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attach).toHaveAttribute('aria-expanded', 'false');
  await expect(attach).toBeFocused();
});

test('INBOX-UX-03: another seller can read media but cannot send, close or attach it to an order', async ({
  page,
}) => {
  await setupInbox(page, { canonicalStatus: 'pendente', otherOwner: true });
  await page.goto('/inbox/conversation-compact');
  await expect(
    page.getByRole('button', { name: 'Ampliar imagem', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Anexar imagem ao pedido', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Encerrar conversa', exact: true }),
  ).toHaveCount(0);
});
