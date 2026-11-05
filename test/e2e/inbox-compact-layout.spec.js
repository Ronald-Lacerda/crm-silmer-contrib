import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

/**
 * INBOX-UX-03 / CP-10: fixtures deliberately separate the canonical header
 * order from a pending order linked only by subject. No real contact data.
 * @param {import('@playwright/test').Page} page
 * @param {{canonicalStatus?: 'confirmado'|'pendente'|null, pending?: boolean, pendingOnFirstClose?: boolean, otherOwner?: boolean, longContext?: boolean}} [options]
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
    handoff: options.longContext
      ? {
          id: 'handoff-long',
          status: 'claimed',
          reasonCode: 'customer_requested_human',
        }
      : null,
    hasPendingOrder: pending,
    id: 'conversation-compact',
    lastMessage: {
      authorKind: 'contact',
      direction: 'inbound',
      id: 'message-compact',
      occurredAt: '2026-11-03T11:27:00.000Z',
      preview: options.longContext
        ? 'Pode fechar esta compra com os detalhes combinados. '.repeat(45)
        : 'Pode conferir esta referência?',
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
    if (
      path ===
      '/api/v1/inbox/conversations/conversation-compact/order-assistance'
    )
      return route.fulfill({
        json: {
          conversationVersion: 3,
          sourceRevision: 4,
          suggestions: options.longContext
            ? [
                {
                  id: 'suggestion-long',
                  version: 1,
                  status: 'pending',
                  productSummary:
                    'Lote sintético com tamanhos e tecidos diferentes. '.repeat(
                      35,
                    ),
                  evidenceMessageId: 'message-compact',
                  sourceRevision: 4,
                  createdAt: '2026-11-03T11:28:00.000Z',
                },
              ]
            : [],
          evaluations: [],
        },
      });
    if (path === '/api/v1/inbox/conversations/conversation-compact/handoff')
      return route.fulfill({
        json: {
          handoff: options.longContext
            ? {
                ...conversation.handoff,
                summary:
                  'Atenção: Conferir prazo e composição antes de confirmar. '.repeat(
                    45,
                  ),
              }
            : null,
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

test('OPS-INBOX-SEND-08: refusing a test conversation preserves the text draft and announces the explicit reason', async ({
  page,
}) => {
  await setupInbox(page, { pending: false });
  let sends = 0;
  await page.route(
    '**/api/v1/conversations/conversation-compact/messages',
    (route) => {
      sends++;
      return route.fulfill({
        status: 403,
        json: {
          accepted: false,
          error: {
            code: 'NON_PRODUCTION_CONVERSATION',
            detail: 'PRIVATE_REFUSAL_CANARY',
          },
        },
      });
    },
  );
  await page.goto('/inbox/conversation-compact');
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await reply.fill('Rascunho sintético preservado');
  await reply.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(
    'Esta conversa é de teste e não envia mensagens pelo WhatsApp.',
  );
  await expect(reply).toHaveValue('Rascunho sintético preservado');
  await expect(page.getByRole('alert')).not.toContainText(
    'PRIVATE_REFUSAL_CANARY',
  );
  expect(sends).toBe(1);
});

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

test('INBOX-UX-04: expanding preserves the live thread and draft, and phone navigation recovers after resize', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 657 });
  await setupInbox(page);
  await page.goto('/inbox/conversation-compact');
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await reply.fill('Rascunho sintético que deve permanecer.');
  const thread = await page.locator('.thread').elementHandle();
  if (!thread) throw new Error('The existing thread must be mounted');
  const url = page.url();
  const before = await page.locator('.inbox-conversation').boundingBox();
  const expand = page.getByRole('button', {
    name: 'Ampliar conversa',
    exact: true,
  });
  await expand.focus();
  await page.keyboard.press('Enter');
  const restore = page.getByRole('button', {
    name: 'Mostrar lista de conversas',
    exact: true,
  });
  await expect(restore).toBeFocused();
  await expect(page.locator('.inbox-list-pane')).toBeHidden();
  const after = await page.locator('.inbox-conversation').boundingBox();
  expect(after?.width).toBeGreaterThan(before?.width ?? 0);
  expect(await thread.evaluate((element) => element.isConnected)).toBe(true);
  await expect(reply).toHaveValue('Rascunho sintético que deve permanecer.');
  await expect(page).toHaveURL(url);
  await page.keyboard.press('Enter');
  await expect(expand).toBeFocused();
  await expect(page.locator('.inbox-list-pane')).toBeVisible();
  await expand.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(expand).toBeHidden();
  await expect(restore).toBeHidden();
  await expect(reply).toHaveValue('Rascunho sintético que deve permanecer.');
  await expect(reply).toBeInViewport({ ratio: 1 });
  await page.getByRole('link', { name: 'Conversas', exact: true }).click();
  await expect(page.locator('.inbox-list-pane')).toBeVisible();
  await expect(page).toHaveURL('/inbox');
  await page.setViewportSize({ width: 1366, height: 657 });
  await expect(page.locator('.inbox-list-pane')).toBeVisible();
});

for (const viewport of [
  { width: 1366, height: 657 },
  { width: 390, height: 844 },
]) {
  test(`INBOX-UX-04: long suggestion and handoff keep reply visible without document scroll at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const state = await setupInbox(page, { longContext: true });
    await page.goto('/inbox/conversation-compact');
    const assistance = page.getByRole('region', {
      name: 'Sugestões de pedido',
    });
    await expect(assistance).toContainText('Lote sintético');
    await expect(page.locator('.thread .order-assistance')).toHaveCount(0);
    const summary = page.getByRole('button', {
      name: 'Resumo da transferência',
      exact: true,
    });
    await summary.click();
    await expect(
      page.getByRole('region', { name: 'Resumo da transferência' }),
    ).toContainText('Conferir prazo e composição');
    await expect(
      page.getByRole('textbox', { name: 'Responder', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole('button', { name: 'Enviar resposta', exact: true }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await page.evaluate(() => ({
        vertical:
          globalThis.document.documentElement.scrollHeight <=
          globalThis.innerHeight,
        horizontal:
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      })),
    ).toEqual({ vertical: true, horizontal: true });
    expect(state.closes).toEqual([]);
    expect(state.orderMutations).toEqual([]);
    expect(state.archives).toEqual([]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test('INBOX-UX-04: archiving the last expanded conversation restores the empty list without sending', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await setupInbox(page, { pending: false });
  let archived = false;
  const mutations = /** @type {string[]} */ ([]);
  const archives = /** @type {any[]} */ ([]);
  page.on('request', (request) => {
    if (
      request.method() !== 'GET' &&
      new URL(request.url()).pathname.startsWith('/api/v1/')
    )
      mutations.push(new URL(request.url()).pathname);
  });
  await page.route('**/api/v1/inbox/conversations?**', async (route) => {
    if (!archived) return route.fallback();
    return route.fulfill({
      json: { items: [], totalCount: 0, nextCursor: null },
    });
  });
  const archivePath = '/api/v1/conversations/conversation-compact/archive';
  await page.route(`**${archivePath}`, async (route) => {
    const request = route.request();
    expect(request.method()).toBe('POST');
    expect(request.headers()['idempotency-key']).toBeTruthy();
    expect(request.headers()['x-csrf-token']).toBe('csrf-compact');
    archives.push(request.postDataJSON());
    archived = true;
    return route.fulfill({ json: { accepted: true } });
  });
  await page.goto('/inbox/conversation-compact');
  await page
    .getByRole('group', { name: 'Atalhos da Caixa' })
    .getByRole('button', { name: /^Todas/u })
    .click();
  await page
    .getByRole('button', { name: 'Ampliar conversa', exact: true })
    .click();
  await expect(page.locator('.inbox-list-pane')).toBeHidden();
  await page.getByRole('button', { name: 'Mais ações', exact: true }).click();
  await page
    .getByRole('group', { name: 'Mais ações', exact: true })
    .getByRole('button', { name: 'Arquivar conversa', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', {
    name: 'Arquivar conversa?',
    exact: true,
  });
  await expect(confirmation).toBeVisible();
  expect(archives).toEqual([]);
  await confirmation
    .getByRole('button', { name: 'Arquivar conversa', exact: true })
    .click();
  await expect(page).toHaveURL('/inbox');
  await expect(confirmation).toBeHidden();
  await expect(page.locator('.inbox-list-pane')).toBeVisible();
  await expect(
    page.getByRole('heading', {
      name: 'Nenhuma conversa por enquanto',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Ampliar conversa', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Mostrar lista de conversas',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(archives).toEqual([
    { expectedVersion: 3, reason: 'Conversa arquivada na Caixa de Entrada' },
  ]);
  expect(mutations).toEqual([archivePath]);
});

test('INBOX-UX-04: at 320px the contact identity and order actions remain separate and usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const state = await setupInbox(page, {
    canonicalStatus: null,
    pending: false,
  });
  await page.goto('/inbox/conversation-compact');
  const name = page.getByRole('button', {
    name: 'Dados de Contato sintético',
    exact: true,
  });
  const header = page.locator('.conv-head');
  await expect(name).toBeInViewport({ ratio: 1 });
  await expect(
    header.getByRole('heading', { name: 'Contato sintético', exact: true }),
  ).toBeVisible();
  await expect(header.locator('.conv-identity')).toContainText('WhatsApp');
  await expect(
    header.getByRole('button', { name: 'Criar pedido', exact: true }),
  ).toBeVisible();
  expect(
    await name
      .locator('span')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const titleBox = await header.locator('.conv-title').boundingBox();
  const identityBox = await header.locator('.conv-identity').boundingBox();
  const actionsBox = await header.locator('.conv-actions').boundingBox();
  if (!titleBox || !identityBox || !actionsBox)
    throw new Error('The identity and actions must have visible bounds');
  expect(titleBox.width).toBeGreaterThanOrEqual(180);
  expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(actionsBox.y + 1);
  expect(identityBox.y + identityBox.height).toBeLessThanOrEqual(
    actionsBox.y + 1,
  );
  for (const control of [
    header.getByRole('link', { name: 'Conversas', exact: true }),
    header.getByRole('button', { name: 'Criar pedido', exact: true }),
    header.getByRole('button', { name: 'Mais ações', exact: true }),
    header.getByRole('button', {
      name: 'Detalhes do atendimento',
      exact: true,
    }),
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(() => ({
      horizontal:
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
      vertical:
        globalThis.document.documentElement.scrollHeight <=
        globalThis.innerHeight,
    })),
  ).toEqual({ horizontal: true, vertical: true });
  expect(state.closes).toEqual([]);
  expect(state.archives).toEqual([]);
  expect(state.orderMutations).toEqual([]);
});
