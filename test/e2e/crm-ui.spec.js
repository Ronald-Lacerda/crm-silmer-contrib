import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const session = {
  user: {
    id: 'operator-1',
    functionName: 'Vendedor',
    capabilities: ['COMMERCIAL_ADMIN'],
  },
};
const card = {
  id: 'deal-1',
  version: 4,
  stage: 'product',
  identification: { customerLabel: 'Cliente 028', orderName: 'Pedido 1042' },
  responsible: { displayLabel: 'Equipe comercial' },
  qualification: { nextPendingField: 'Quantidade', blockerCount: 1 },
  nextTask: { title: 'Confirmar quantidade', dueAt: '2026-09-08T12:00:00Z' },
  stageEnteredAt: '2026-09-06T12:00:00Z',
};
const contact = {
  activeDealCount: 1,
  createdAt: '2026-09-01T12:00:00.000Z',
  id: 'contact-1',
  identities: [
    {
      channel: 'whatsapp',
      displayHandle: 'Studio Malu',
      externalId: '5511999999999',
      id: 'identity-1',
      kind: 'phone',
      phoneStatus: 'confirmed',
    },
  ],
  label: 'Studio Malu',
  latestActivityAt: '2026-09-08T12:00:00.000Z',
  provisional: false,
  updatedAt: '2026-09-08T12:00:00.000Z',
  version: 2,
};
const conversation = {
  assignedUser: { functionName: 'Vendedor', id: 'operator-1' },
  automationEpoch: 2,
  automationState: 'human',
  channel: 'whatsapp',
  contact: {
    displayHandle: 'Studio Malu',
    externalId: '5511999999999',
    id: contact.id,
    label: 'Studio Malu',
  },
  deal: { id: card.id, stage: 'produto', status: 'active' },
  handoff: null,
  id: 'conversation-1',
  lastMessage: {
    deliveryStatus: null,
    direction: 'inbound',
    authorId: 'contact-1',
    authorKind: 'contact',
    id: 'message-1',
    occurredAt: '2026-09-08T12:00:00.000Z',
    preview: 'Preciso de 120 camisetas.',
    status: 'received',
    type: 'text',
  },
  openedAt: '2026-09-08T11:00:00.000Z',
  requiresAttention: false,
  state: 'em_atendimento',
  terminalAt: null,
  updatedAt: '2026-09-08T12:00:00.000Z',
  version: 3,
};
/**
 * PCX-03/PCX-04: three conversations the agent stopped, each for a different
 * reason and waiting for a different length of time. They are declared out of
 * order on purpose, so a list that renders them oldest-first proves it sorted
 * rather than echoed the answer.
 *
 * @param {Date} now
 */
function waitingConversations(now) {
  /** @param {number} minutes */
  const ago = (minutes) =>
    new Date(now.getTime() - minutes * 60_000).toISOString();
  return [
    ['conversation-1', 'Studio Malu', 'price_before_quote', 134],
    ['conversation-2', 'Time Fênix Futsal', 'customer_requested_human', 1623],
    ['conversation-3', 'Igreja Nova Aliança', 'briefing_complete', 47],
  ].map(([id, label, reasonCode, waitedMinutes]) => ({
    ...conversation,
    assignedUser: null,
    contact: { ...conversation.contact, label: String(label) },
    handoff: {
      createdAt: ago(Number(waitedMinutes)),
      dueAt: '2026-09-08T16:10:00.000Z',
      id: `handoff-${id}`,
      reasonCode,
      status: 'pending',
      targetRole: 'Vendedor',
      version: 1,
    },
    id: String(id),
    requiresAttention: true,
    state: 'requer_atencao',
  }));
}

/** @param {import('@playwright/test').Page} page @param {string} situation @param {string} [owner] */
async function selectInboxFilters(page, situation, owner) {
  await page.getByRole('button', { name: /^Filtros/u }).click();
  const sheet = page.getByRole('dialog', { name: 'Filtrar conversas' });
  await sheet
    .getByRole('group', { name: 'Situação' })
    .getByRole('radio', { name: situation, exact: true })
    .check();
  if (owner)
    await sheet
      .getByRole('group', { name: 'Responsável' })
      .getByRole('radio', { name: owner, exact: true })
      .check();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
}

/**
 * One SSE payload delivered on connect, with a long retry so the reconnect
 * does not turn a single event into a refresh loop during the test.
 *
 * @param {Record<string, unknown>|null} event
 */
function eventStreamBody(event) {
  if (!event) return 'retry: 60000\n\n: connected\n\n';
  return [
    'retry: 60000',
    '',
    `event: ${event.type}`,
    'id: evt-2',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}

/** The pending order of `conversation-1`, as the orders read model presents it. */
const conversationOrder = {
  confirmedAt: null,
  confirmedBy: null,
  conversationId: 'conversation-1',
  createdAt: '2026-09-08T12:30:00.000Z',
  fabCode: 'FAB 01',
  ficha: {
    items: [
      {
        grade: [
          { quantidade: 100, tamanho: 'M' },
          { quantidade: 50, tamanho: 'G' },
        ],
        gola: 'GOLA OLÍMPICA',
        tipo: 'CAMISETA',
      },
    ],
    observations: [],
    serviceData: {},
    summary: {
      aplicacao: 'SUBLIMAÇÃO TOTAL',
      cliente: 'Studio Malu',
      data_entrega_confirmada: '2026-10-24',
      nome: 'Uniforme escolar 2027',
    },
  },
  finalAmountCents: null,
  id: 'order-pendente',
  missingFields: ['finalAmount', 'paymentCondition'],
  number: '07-CRM',
  orderDate: null,
  paymentCondition: null,
  reopenedAt: null,
  reopenedBy: null,
  seller: { id: 'operator-1', name: 'Marina Aguiar' },
  status: 'pendente',
  totalPieces: 150,
  updatedAt: '2026-09-08T12:46:00.000Z',
  version: 2,
};

/** @param {import('@playwright/test').Page} page @param {{assistant?: boolean, assistantKeepsOwner?: boolean, claimGate?: Promise<void>, claimTakesOver?: boolean, conflict?: boolean, confirmOnRefresh?: boolean, empty?: boolean, emptyWhen?:(params:URLSearchParams)=>boolean, failBoard?: boolean, failDetailOnce?: boolean, failInboxList?:(params:URLSearchParams)=>boolean, failedDelivery?: boolean, handoffReason?: string, liveEvent?: Record<string, unknown>|null, longThread?: boolean, manyContacts?: boolean, manyConversations?: boolean, mixedAuthors?: boolean, newMessageOnRefresh?: boolean, noAdmin?: boolean, onBoard?:()=>void, onCreateOrder?:(body:any)=>void, onHandoffClaim?:(body:any)=>void, onInboxList?:(params:URLSearchParams)=>void, onMessage?:(body:any)=>void, order?: any, otherOwner?: boolean, pendingHandoff?:boolean, siteChat?:boolean, suggestion?:boolean, waitingQueue?:boolean}} [options] */
async function mockCrm(page, options = {}) {
  let conflict = options.conflict ?? false;
  let failDetail = options.failDetailOnce ?? false;
  let inboxListCalls = 0;
  const waiting = options.waitingQueue ? waitingConversations(new Date()) : [];
  // The conversation carries the order summary the Inbox read model joins in,
  // so the header button and the drawer never disagree about which order it is.
  let currentOrder = options.order === undefined ? null : options.order;
  /** @param {any} order */
  const orderSummary = (order) =>
    order
      ? {
          id: order.id,
          number: order.number,
          status: order.status,
          readyForConfirmation:
            order.status === 'pendente' &&
            Array.isArray(order.missingFields) &&
            order.missingFields.length === 0,
        }
      : null;
  const activeSession = options.noAdmin
    ? { user: { ...session.user, capabilities: [] } }
    : session;
  const inboxConversation = options.pendingHandoff
    ? {
        ...conversation,
        assignedUser: null,
        handoff: {
          dueAt: '2026-09-08T16:10:00.000Z',
          id: 'handoff-1',
          ...(options.handoffReason
            ? { reasonCode: options.handoffReason }
            : {}),
          status: 'pending',
          targetRole: 'Vendedor',
          version: 1,
        },
        requiresAttention: true,
        state: 'requer_atencao',
      }
    : options.assistant
      ? {
          ...conversation,
          assignedUser: options.assistantKeepsOwner
            ? conversation.assignedUser
            : null,
          automationState: 'assistant',
        }
      : conversation;
  // PCX-13: once the claim is accepted, the conversation is the seller's.
  let claimed = false;
  /** The list and the detail answer the same conversation, order included. */
  const withOrder = () => ({
    ...(claimed ? conversation : inboxConversation),
    ...(options.siteChat
      ? {
          channel: 'site_chat',
          contact: {
            ...inboxConversation.contact,
            externalId: '999001899004479995964365389745407152128',
            phone: '5527999991234',
            phoneSource: 'site_unverified',
          },
        }
      : {}),
    ...(options.otherOwner
      ? { assignedUser: { functionName: 'Vendedor', id: 'operator-2' } }
      : {}),
    order: orderSummary(currentOrder),
  });
  const detailMessages = options.mixedAuthors
    ? [
        conversation.lastMessage,
        {
          ...conversation.lastMessage,
          authorId: 'AUTOMATION_EXECUTOR',
          authorKind: 'assistant',
          deliveryStatus: 'sent',
          direction: 'outbound',
          id: 'message-assistant',
          preview: 'Posso ajudar a organizar seu pedido.',
        },
        {
          ...conversation.lastMessage,
          authorId: 'operator-1',
          authorKind: 'human',
          deliveryErrorCode: options.failedDelivery
            ? 'N8N_COMMAND_HTTP_401'
            : null,
          deliveryStatus: options.failedDelivery ? 'failed' : null,
          direction: 'outbound',
          id: 'message-human',
          preview: 'Vou assumir seu atendimento agora.',
        },
      ]
    : options.longThread
      ? Array.from({ length: 30 }, (_, index) => ({
          ...conversation.lastMessage,
          id: `message-${index + 1}`,
          preview: `Mensagem de teste ${index + 1}: detalhes do atendimento.`,
        }))
      : [conversation.lastMessage];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/v1/sessions/current') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(activeSession),
      });
      return;
    }
    if (path === '/api/v1/events') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: { 'Cache-Control': 'no-cache' },
        body: eventStreamBody(options.liveEvent ?? null),
      });
      return;
    }
    if (path === '/api/v1/orders/delivery-tasks') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ items: [] }),
      });
      return;
    }
    if (path === '/api/v1/orders/summary' && request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          averageTicketCents: 125000,
          confirmedCount: 2,
          pendingCount: 1,
          soldAmountCents: 250000,
          totalPiecesSold: 300,
          period: {
            confirmedCount: 2,
            from: '2026-10-15',
            key: 'hoje',
            soldAmountCents: 250000,
            timeZone: 'America/Sao_Paulo',
            to: '2026-10-15',
          },
          deliveries: {
            dueSoonCount: 0,
            dueSoonUntil: '2026-10-21',
            oldestOverdueOn: null,
            overdueCount: 0,
          },
          today: '2026-10-15',
        }),
      });
      return;
    }
    if (path === '/api/v1/inbox/summary' && request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          assistant: {
            activeCount: 1,
            failedDeliveryCount: 0,
            lastReplyAt: null,
            stallMinutes: 10,
            stalledCount: 0,
          },
          generatedAt: '2026-10-15T15:00:00.000Z',
          mine: { awaitingReplyCount: 1, count: 1, oldestAwaitingSince: null },
          waitingHandoff: { count: 0, oldestSince: null, overdueCount: 0 },
        }),
      });
      return;
    }
    if (path === '/api/v1/kanban' && request.method() === 'GET') {
      options.onBoard?.();
      if (options.failBoard) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'UNAVAILABLE' }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          eventCursor: 'evt-8',
          columns: options.empty
            ? []
            : [
                {
                  cards: [card],
                  count: 1,
                  items: [card],
                  label: 'Produto',
                  stage: 'product',
                  total: 1,
                },
              ],
        }),
      });
      return;
    }
    if (path === '/api/v1/inbox/conversations' && request.method() === 'GET') {
      options.onInboxList?.(url.searchParams);
      inboxListCalls += 1;
      if (options.failInboxList?.(url.searchParams)) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'UNAVAILABLE' }),
        });
        return;
      }
      // Somebody else confirmed the order between the first read and the
      // refresh the live event triggers.
      if (options.confirmOnRefresh && inboxListCalls > 1 && currentOrder) {
        currentOrder = { ...currentOrder, status: 'confirmado' };
      }
      const currentConversation = withOrder();
      const candidates =
        options.empty || options.emptyWhen?.(url.searchParams)
          ? []
          : waiting.length
            ? waiting
            : options.manyConversations
              ? Array.from({ length: 40 }, (_, index) => ({
                  ...currentConversation,
                  contact: {
                    ...currentConversation.contact,
                    label: `Cliente de teste ${index + 1}`,
                  },
                  id: index
                    ? `conversation-${index + 1}`
                    : currentConversation.id,
                }))
              : [
                  options.newMessageOnRefresh && inboxListCalls > 1
                    ? {
                        ...currentConversation,
                        lastMessage: {
                          ...currentConversation.lastMessage,
                          id: 'message-new',
                          preview: 'Mensagem nova de teste',
                        },
                      }
                    : currentConversation,
                ];
      const items =
        url.searchParams.get('workQueue') === 'closing'
          ? candidates.filter(
              (item) =>
                /** @type {any} */ (item).order?.readyForConfirmation === true,
            )
          : candidates;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items,
          nextCursor: null,
          totalCount: items.length,
        }),
      });
      return;
    }
    if (
      /^\/api\/v1\/inbox\/conversations\/[^/]+\/subjects$/u.test(path) &&
      request.method() === 'GET'
    ) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          currentSubjectId: null,
          links: [],
          orders: [],
          ordersHasMore: false,
          subjects: [],
        }),
      });
      return;
    }
    const inboxDetail = /^\/api\/v1\/inbox\/conversations\/([^/]+)$/u.exec(
      path,
    );
    if (inboxDetail && request.method() === 'GET') {
      const selected =
        waiting.find((item) => item.id === inboxDetail[1]) ??
        (inboxDetail[1] === 'conversation-1' ? withOrder() : null);
      if (!selected) {
        await route.fulfill({
          status: 404,
          contentType: 'application/problem+json',
          body: '{}',
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          conversation: selected,
          messages: detailMessages,
          suggestion: options.suggestion
            ? {
                automationEpoch: 2,
                createdAt: '2026-09-08T12:05:00.000Z',
                id: 'suggestion-1',
                proposedStage: 'produto',
                question: 'Confirmo a quantidade com o cliente?',
                sourceMessageId: 'message-1',
                status: 'pending',
              }
            : null,
        }),
      });
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-1/order' &&
      request.method() === 'GET'
    ) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ order: currentOrder }),
      });
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-1/orders' &&
      request.method() === 'POST'
    ) {
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.headers()['x-csrf-token']).toBe('csrf-test');
      const body = request.postDataJSON();
      options.onCreateOrder?.(body);
      // PCL-11: an existing pending order is answered, never a second one.
      const created = currentOrder === null;
      if (created) {
        currentOrder = {
          ...conversationOrder,
          id: 'order-novo',
          missingFields: ['items', 'finalAmount', 'paymentCondition'],
          number: '11-CRM',
          ficha: { ...conversationOrder.ficha, items: [] },
          totalPieces: 0,
          version: 1,
        };
      }
      await route.fulfill({
        status: created ? 201 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ order: currentOrder }),
      });
      return;
    }
    if (
      path === '/api/v1/handoffs/handoff-1/claim' &&
      request.method() === 'POST'
    ) {
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.headers()['x-csrf-token']).toBe('csrf-test');
      options.onHandoffClaim?.(request.postDataJSON());
      // Held open by the test, so a second press lands while it is in flight.
      if (options.claimGate) await options.claimGate;
      if (options.claimTakesOver) claimed = true;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true }),
      });
      return;
    }
    if (
      path === '/api/v1/conversations/conversation-1/messages' &&
      request.method() === 'POST'
    ) {
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.headers()['x-csrf-token']).toBe('csrf-test');
      const body = request.postDataJSON();
      options.onMessage?.(body);
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ accepted: true }),
      });
      return;
    }
    if (path === '/api/v1/contacts' && request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: options.empty
            ? []
            : options.manyContacts
              ? Array.from({ length: 60 }, (_, index) => ({
                  ...contact,
                  id: index ? `contact-${index + 1}` : contact.id,
                  label: index
                    ? `Cliente de teste ${index + 1}`
                    : contact.label,
                }))
              : [contact],
          nextCursor: null,
          totalCount: options.empty ? 0 : options.manyContacts ? 60 : 1,
        }),
      });
      return;
    }
    if (path === '/api/v1/contacts/contact-1' && request.method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          activeDealCount: 1,
          contact,
          conversations: [conversation],
          deals: [
            {
              assignedUser: null,
              createdAt: '2026-09-06T12:00:00.000Z',
              id: card.id,
              stage: 'produto',
              status: 'active',
              updatedAt: '2026-09-08T12:00:00.000Z',
              version: 4,
            },
          ],
          identities: contact.identities,
        }),
      });
      return;
    }
    if (path === '/api/v1/deals/deal-1' && request.method() === 'GET') {
      if (failDetail) {
        failDetail = false;
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'UNAVAILABLE' }),
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        headers: { ETag: '"deal-1-v4"' },
        body: JSON.stringify({
          eventCursor: 'evt-8',
          deal: {
            ...card,
            status: 'OPEN',
          },
          qualification: {
            assessments: [
              { field: 'items[0].estimatedQuantity', status: 'pending' },
              { field: 'order.customer', status: 'confirmed' },
            ],
            order: {
              commercialIntent: 'uniforme',
              customerPresent: true,
              namePresent: true,
            },
            items: [
              {
                productCode: 'camiseta',
                modelCode: 'tradicional',
                fabrics: [{ code: 'algodao' }],
                grade: [{ sizeLookup: 'M', quantity: 120 }],
                estimatedQuantity: 120,
                catalogVersionNumber: 3,
              },
            ],
            artwork: {
              techniqueCode: 'silk',
              colorsCount: 2,
              locationsCount: 1,
              status: 'pending',
            },
            logistics: {
              mode: 'delivery',
              desiredDate: '2026-09-30',
              addressPresent: true,
              pickupLocationPresent: false,
            },
            totalQuantity: 120,
          },
          nextTask: {
            id: 'task-1',
            type: 'follow_up',
            status: 'pending',
            version: 2,
            dueAt: '2026-09-08T12:00:00Z',
          },
          tasks: [
            {
              id: 'task-1',
              type: 'follow_up',
              status: 'pending',
              version: 2,
              dueAt: '2026-09-08T12:00:00Z',
            },
          ],
          handoffs: [
            {
              id: 'handoff-1',
              reasonCode: 'automation_sla',
              status: 'pending',
              version: 1,
              dealVersion: 4,
              conversationVersion: 3,
              taskId: 'task-handoff-1',
              taskVersion: 1,
            },
          ],
          gates: [
            {
              fromStage: 'produto',
              blockers: ['items[0].estimatedQuantity'],
              sourceVersion: 4,
              evaluatedAt: '2026-09-06T12:00:00Z',
            },
          ],
          history: [
            {
              eventKind: 'deal.created',
              occurredAt: '2026-09-06T12:00:00Z',
              resultingVersion: 1,
            },
          ],
        }),
      });
      return;
    }
    if (
      path === '/api/v1/deals/deal-1/transitions' &&
      request.method() === 'POST'
    ) {
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toMatchObject({
        direction: 'forward',
        expectedVersion: 4,
      });
      if (conflict) {
        conflict = false;
        await route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'STALE_VERSION' }),
        });
      } else await route.fulfill({ status: 204 });
      return;
    }
    if (path === '/api/v1/tasks/task-1/start' && request.method() === 'POST') {
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toEqual({
        expectedTaskVersion: 2,
        reasonCode: 'manual_follow_up',
      });
      await route.fulfill({ contentType: 'application/json', body: '{}' });
      return;
    }
    if (
      path === '/api/v1/handoffs/handoff-1/accept' &&
      request.method() === 'POST'
    ) {
      expect(request.headers()['idempotency-key']).toBeTruthy();
      expect(request.postDataJSON()).toEqual({
        expectedConversationVersion: 3,
        expectedDealVersion: 4,
        expectedHandoffVersion: 1,
        expectedTaskVersion: 1,
        reasonCode: 'handoff_accepted',
      });
      await route.fulfill({ contentType: 'application/json', body: '{}' });
      return;
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/problem+json',
      body: '{}',
    });
  });
}

test.skip('renders the five-stage Kanban and opens a deal with keyboard', async ({
  page,
}) => {
  await mockCrm(page);
  await page.goto('/kanban');
  await expect(
    page.getByRole('heading', { name: 'Kanban comercial' }),
  ).toBeFocused();
  for (const name of [
    'Produto',
    'Especificação',
    'Estampa',
    'Logística',
    'Fechamento',
  ])
    await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('Cliente 028')).toBeVisible();
  await page.getByRole('link', { name: /Cliente 028/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/negocios/deal-1');
  await expect(
    page.getByRole('heading', { name: 'Cliente 028' }),
  ).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Tarefas' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Transferências e retomadas' }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL('/negocios/deal-1');
  await expect(
    page.getByRole('heading', { name: 'Cliente 028' }),
  ).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Aceitar retomada' }),
  ).toBeVisible();
  const startTask = page.getByRole('button', { name: 'Iniciar' });
  await startTask.click();
  await expect(page.getByRole('status')).toHaveText(
    'Tarefa atualizada: iniciar.',
  );
  await expect(startTask).toBeFocused();
  const acceptHandoff = page.getByRole('button', { name: 'Aceitar retomada' });
  await acceptHandoff.click();
  await expect(page.getByRole('status')).toHaveText(
    'Aceitar retomada concluída.',
  );
  await expect(acceptHandoff).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('exposes the CRM screens as authenticated Vue routes', async ({
  page,
}) => {
  await mockCrm(page);
  await page.goto('/dashboard');

  await expect(
    page.getByRole('heading', { name: 'Dashboard', level: 1 }),
  ).toBeFocused();
  for (const name of [
    'Dashboard',
    'Caixa de Entrada',
    'Usuários',
    'Clientes',
    'Conta',
  ]) {
    await expect(
      page
        .getByRole('navigation', { name: 'Navegação principal' })
        .getByRole('link', { name }),
    ).toBeVisible();
  }
  // Painel: each indicator is a link to the list it counts.
  await expect(
    page.getByRole('link', { name: /^Vendido hoje R\$\s2\.500,00/u }),
  ).toHaveAttribute('href', '/pedidos?status=confirmado');
  await expect(
    page.getByRole('link', { name: /^Minhas conversas 1/u }),
  ).toHaveAttribute('href', '/inbox?fila=minhas');

  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('link', { name: 'Caixa de Entrada' })
    .press('Enter');
  await expect(page).toHaveURL('/inbox');
  await expect(
    page.getByRole('heading', { name: 'Caixa de Entrada' }),
  ).toBeFocused();
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Navegação principal' })
    .getByRole('link', { name: 'Clientes' })
    .press('Enter');
  await expect(page).toHaveURL('/clientes');
  await expect(
    page.getByRole('heading', { name: 'Clientes', level: 1 }),
  ).toBeFocused();
  await expect(page.getByRole('link', { name: 'Studio Malu' })).toBeVisible();

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('selects a conversation subject by keyboard and restores focus', async ({
  page,
}) => {
  await mockCrm(page);
  let currentSubjectId = 'subject-general';
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/subjects?*',
    async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          currentSubjectId,
          links: [],
          orders: [],
          ordersHasMore: false,
          subjects: [
            {
              id: 'subject-general',
              kind: 'geral',
              orderId: null,
              orderNumber: null,
              orderStatus: null,
              position: 1,
              isCurrent: currentSubjectId === 'subject-general',
              selectedSource: 'human',
              version: 1,
            },
            {
              id: 'subject-order',
              kind: 'pedido',
              orderId: 'order-1',
              orderNumber: '01-CRM',
              orderStatus: 'pendente',
              position: 2,
              isCurrent: currentSubjectId === 'subject-order',
              selectedSource: 'human',
              version: 1,
            },
          ],
        }),
      });
    },
  );
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/subjects/subject-order/select',
    async (route) => {
      expect(route.request().headers()['idempotency-key']).toBeTruthy();
      currentSubjectId = 'subject-order';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ currentSubjectId, version: 2 }),
      });
    },
  );

  await page.goto('/inbox');
  // INBOX-UX-03: subjects open on demand without narrowing the conversation.
  await page
    .getByRole('button', { name: 'Detalhes do atendimento', exact: true })
    .click();
  const panel = page.locator('.subject-panel');
  // UXA-04: the badge and the button say they change what the agent uses.
  await expect(panel.getByText('Em foco')).toBeVisible();
  const select = panel.getByRole('button', {
    name: 'Usar este: fazer o agente usar Pedido 01-CRM',
  });
  await expect(select).toBeVisible();
  await select.focus();
  await select.press('Enter');
  await expect(
    panel.getByRole('heading', { name: 'Assuntos do atendimento' }),
  ).toBeFocused();
  await expect(panel.getByRole('status')).toHaveText(
    'Pronto. O agente passa a usar este.',
  );
  expect(currentSubjectId).toBe('subject-order');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

/**
 * CP-16: the subjects of `conversation-1`, as the read model answers them.
 * `needsSubjectMessageIds` is left out when not given, as an API that does
 * not flag messages yet would answer.
 *
 * @param {{links?: any[], needs?: string[], subjects: any[]}} state
 */
function subjectsBody(state) {
  return JSON.stringify({
    currentSubjectId: state.subjects.find((item) => item.isCurrent)?.id ?? null,
    links: state.links ?? [],
    ...(state.needs ? { needsSubjectMessageIds: state.needs } : {}),
    orders: [],
    ordersHasMore: false,
    subjects: state.subjects,
  });
}

/** @param {string} id @param {string|null} orderNumber @param {number} position */
function subjectRow(id, orderNumber, position) {
  return {
    id,
    isCurrent: position === 1,
    kind: orderNumber ? 'pedido' : 'geral',
    orderId: orderNumber ? `order-${position}` : null,
    orderNumber,
    orderStatus: orderNumber ? 'pendente' : null,
    position,
    selectedSource: 'agent',
    version: 1,
  };
}

const twoSubjects = [
  subjectRow('subject-order', '01-CRM', 1),
  subjectRow('subject-general', null, 2),
];

/** @param {import('@playwright/test').Page} page @param {() => any} state */
async function routeSubjects(page, state) {
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/subjects?*',
    async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: subjectsBody(state()),
      });
    },
  );
}

test('a conversation with one subject shows no subject control on its messages', async ({
  page,
}) => {
  await mockCrm(page, { mixedAuthors: true });
  // UXA-01: with one order everything is its; nothing to decide or read.
  await routeSubjects(page, () => ({
    links: [
      {
        assignedByKind: 'agent',
        messageId: 'message-1',
        subjectId: 'subject-order',
      },
    ],
    subjects: [subjectRow('subject-order', '01-CRM', 1)],
  }));
  await page.goto('/inbox');
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  await expect(thread.getByText('Preciso de 120 camisetas.')).toBeVisible();
  await expect(thread.locator('details, fieldset')).toHaveCount(0);
  await expect(thread.getByText(/Pedido 01-CRM/u)).toHaveCount(0);
  await expect(thread.getByRole('button', { name: 'Corrigir' })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('asks which order only on the flagged message and confirms in its bubble', async ({
  page,
}) => {
  await mockCrm(page, { mixedAuthors: true });
  /** @type {{links?: any[], needs?: string[], subjects: any[]}} */
  let state = { needs: ['message-1'], subjects: twoSubjects };
  await routeSubjects(page, () => state);
  let putBody;
  let putKey;
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/messages/message-1/subjects',
    async (route) => {
      putBody = route.request().postDataJSON();
      putKey = route.request().headers()['idempotency-key'];
      state = {
        links: [
          {
            assignedByKind: 'human',
            messageId: 'message-1',
            subjectId: 'subject-order',
          },
        ],
        needs: [],
        subjects: twoSubjects,
      };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          messageId: 'message-1',
          subjectIds: ['subject-order'],
        }),
      });
    },
  );
  await page.goto('/inbox');
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  const question = thread.getByRole('group', {
    name: 'A qual pedido esta mensagem se refere?',
  });
  await expect(question).toHaveCount(1);
  const flagged = thread
    .getByRole('listitem')
    .filter({ hasText: 'Preciso de 120 camisetas.' });
  await expect(flagged.getByRole('group')).toBeVisible();
  // UXA-04: a general subject is not numbered by its place.
  await expect(
    question.getByRole('button', { name: 'Assunto sem pedido', exact: true }),
  ).toBeVisible();
  await expect(
    question.getByRole('button', { name: 'Nenhum pedido' }),
  ).toBeVisible();
  await expect(
    question.getByRole('button', { name: 'Separar como novo assunto' }),
  ).toBeVisible();
  const more = question.getByRole('button', { name: 'Mais de um' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  const order = question.getByRole('button', { name: 'Pedido 01-CRM' });
  await order.focus();
  await order.press('Enter');
  const answer = flagged.getByRole('status');
  await expect(answer).toHaveText('Ligada ao Pedido 01-CRM por você.');
  await expect(answer).toBeFocused();
  expect(putBody).toEqual({ subjectIds: ['subject-order'] });
  expect(putKey).toBeTruthy();
  await expect(question).toHaveCount(0);
  // CP-14: the seller's link reads as theirs.
  await expect(
    flagged.getByText('Pedido 01-CRM · pelo vendedor'),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('separates a flagged message as a new subject and retries with the same subject', async ({
  page,
}) => {
  await mockCrm(page, { mixedAuthors: true });
  /** @type {{links?: any[], needs?: string[], subjects: any[]}} */
  let state = { needs: ['message-1'], subjects: twoSubjects };
  await routeSubjects(page, () => state);
  /** @type {any[]} */
  const created = [];
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/subjects',
    async (route) => {
      const body = route.request().postDataJSON();
      created.push(body);
      // CP-30: as the API, only a create without `select: false` would move
      // the agent to the new subject.
      const selects = body?.select !== false;
      if (selects) {
        state = {
          ...state,
          subjects: state.subjects.map((item) => ({
            ...item,
            isCurrent: false,
          })),
        };
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          subject: {
            ...subjectRow('subject-new', null, 3),
            isCurrent: selects,
          },
        }),
      });
    },
  );
  /** @type {{body: any, key: string|undefined}[]} */
  const puts = [];
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/messages/message-1/subjects',
    async (route) => {
      puts.push({
        body: route.request().postDataJSON(),
        key: route.request().headers()['idempotency-key'],
      });
      if (puts.length === 1) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: '{}',
        });
        return;
      }
      state = {
        links: [
          {
            assignedByKind: 'human',
            messageId: 'message-1',
            subjectId: 'subject-new',
          },
        ],
        needs: [],
        subjects: [
          ...state.subjects,
          { ...subjectRow('subject-new', null, 3), isCurrent: false },
        ],
      };
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          messageId: 'message-1',
          subjectIds: ['subject-new'],
        }),
      });
    },
  );
  await page.goto('/inbox');
  const question = page.getByRole('group', {
    name: 'A qual pedido esta mensagem se refere?',
  });
  const separate = question.getByRole('button', {
    name: 'Separar como novo assunto',
  });
  await separate.click();
  // The error stays beside the question and the focus stays on the button.
  await expect(question.getByRole('alert')).toHaveText(
    'Não deu para salvar. A pergunta continua aqui; tente de novo.',
  );
  await expect(separate).toBeFocused();
  await separate.press('Enter');
  await expect(page.locator('.thread').getByRole('status')).toHaveText(
    'Ligada ao Assunto sem pedido (2) por você.',
  );
  // The subject already created is linked again, not created twice, and the
  // agent keeps the subject it was using (CP-30).
  expect(created).toEqual([{ orderId: null, select: false }]);
  expect(JSON.parse(subjectsBody(state)).currentSubjectId).toBe(
    'subject-order',
  );
  expect(puts.map((put) => put.body)).toEqual([
    { subjectIds: ['subject-new'] },
    { subjectIds: ['subject-new'] },
  ]);
  expect(puts[1].key).toBe(puts[0].key);
});

test('a linked customer message says who linked it and Corrigir opens the question', async ({
  page,
}) => {
  await mockCrm(page, { mixedAuthors: true });
  await routeSubjects(page, () => ({
    links: [
      {
        assignedByKind: 'agent',
        messageId: 'message-1',
        subjectId: 'subject-order',
      },
      {
        assignedByKind: 'agent',
        messageId: 'message-assistant',
        subjectId: 'subject-order',
      },
    ],
    subjects: twoSubjects,
  }));
  await page.goto('/inbox');
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  const customer = thread
    .getByRole('listitem')
    .filter({ hasText: 'Preciso de 120 camisetas.' });
  await expect(customer.getByText('Pedido 01-CRM · pelo agente')).toBeVisible();
  // UXA-01: the agent's own messages carry no chip.
  await expect(thread.getByText(/· pelo agente/u)).toHaveCount(1);
  await expect(thread.getByRole('group')).toHaveCount(0);
  const correct = customer.getByRole('button', { name: 'Corrigir' });
  await correct.focus();
  await correct.press('Enter');
  const question = customer.getByRole('group', {
    name: 'A qual pedido esta mensagem se refere?',
  });
  await expect(question).toBeVisible();
  await expect(
    question.getByRole('button', { name: 'Pedido 01-CRM' }),
  ).toBeFocused();
  await expect(
    question.getByRole('checkbox', { name: 'Pedido 01-CRM' }),
  ).toBeChecked();
  await expect(
    question.getByRole('checkbox', { name: 'Assunto sem pedido' }),
  ).not.toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await question.getByRole('button', { name: 'Cancelar' }).click();
  await expect(question).toHaveCount(0);
  await expect(
    customer.getByRole('button', { name: 'Corrigir' }),
  ).toBeFocused();
});

test('a stop over which order explains itself before the takeover', async ({
  page,
}) => {
  await mockCrm(page, {
    handoffReason: 'low_confidence',
    mixedAuthors: true,
    pendingHandoff: true,
  });
  await routeSubjects(page, () => ({
    needs: ['message-1'],
    subjects: [subjectRow('subject-order', '01-CRM', 1)],
  }));
  await page.goto('/inbox');
  // UXA-03: the reason, not "Agente sem confiança".
  const reason = page.locator('#takeover-reason');
  await expect(reason).toContainText(
    'O agente parou para não misturar pedidos.',
  );
  await expect(reason).toContainText(
    'Ao assumir, indique a qual pedido a mensagem se refere.',
  );
  // UXA-10: before taking it, an administrator too reads why, not controls.
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  await expect(thread.getByRole('group')).toHaveCount(0);
  await expect(
    thread.getByText(
      'O agente não soube a qual pedido esta mensagem se refere. Assuma o atendimento para indicar.',
    ),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('a stop for another reason keeps its own words with a message to review', async ({
  page,
}) => {
  await mockCrm(page, {
    handoffReason: 'complaint',
    mixedAuthors: true,
    pendingHandoff: true,
  });
  await routeSubjects(page, () => ({
    needs: ['message-1'],
    subjects: twoSubjects,
  }));
  await page.goto('/inbox');
  const reason = page.locator('#takeover-reason');
  await expect(reason.locator('strong')).toHaveText('Reclamação');
  await expect(reason).not.toContainText('não misturar pedidos');
});

test('keeps the boxes checked under Mais de um through a live refresh', async ({
  page,
}) => {
  await mockCrm(page, { mixedAuthors: true });
  let subjectReads = 0;
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/subjects?*',
    async (route) => {
      subjectReads += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: subjectsBody({ needs: ['message-1'], subjects: twoSubjects }),
      });
    },
  );
  /** @type {() => void} */
  let sendEvent = () => {};
  const eventGate = new Promise((resolve) => {
    sendEvent = () => resolve(null);
  });
  await page.route(/\/api\/v1\/events\?/u, async (route) => {
    await eventGate;
    return route.fulfill({
      body: eventStreamBody({
        payload: { conversationId: 'conversation-1' },
        type: 'inbox.conversation.changed',
      }),
      contentType: 'text/event-stream',
      status: 200,
    });
  });
  /** @type {any} */
  let putBody;
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1/messages/message-1/subjects',
    async (route) => {
      putBody = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          messageId: 'message-1',
          subjectIds: putBody.subjectIds,
        }),
      });
    },
  );
  await page.goto('/inbox');
  const question = page.getByRole('group', {
    name: 'A qual pedido esta mensagem se refere?',
  });
  await question.getByRole('button', { name: 'Mais de um' }).click();
  const order = question.getByRole('checkbox', { name: 'Pedido 01-CRM' });
  const general = question.getByRole('checkbox', {
    name: 'Assunto sem pedido',
  });
  await order.check();
  await general.check();
  const readsBefore = subjectReads;
  // A live event refreshes the conversation silently while the seller works.
  sendEvent();
  await expect.poll(() => subjectReads).toBeGreaterThan(readsBefore);
  await expect(order).toBeChecked();
  await expect(general).toBeChecked();
  await question.getByRole('button', { name: 'Ligar aos marcados' }).click();
  await expect(page.locator('.thread').getByRole('status')).toContainText(
    'por você.',
  );
  expect(putBody).toEqual({
    subjectIds: ['subject-general', 'subject-order'],
  });
});

test('does not ask which order to someone the API would refuse', async ({
  page,
}) => {
  // CP-14: another seller's conversation, seen by a seller who is not admin.
  await mockCrm(page, { mixedAuthors: true, noAdmin: true, otherOwner: true });
  await routeSubjects(page, () => ({
    links: [
      {
        assignedByKind: 'agent',
        messageId: 'message-1',
        subjectId: 'subject-order',
      },
    ],
    needs: ['message-1'],
    subjects: twoSubjects,
  }));
  await page.goto('/inbox');
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  await expect(
    thread.getByText(
      'O agente não soube a qual pedido esta mensagem se refere. Aguardando o vendedor indicar o pedido.',
    ),
  ).toBeVisible();
  await expect(thread.getByRole('group')).toHaveCount(0);
  await expect(thread.getByRole('button', { name: 'Corrigir' })).toHaveCount(0);
});

test('claims a pending handoff from its conversation in the Caixa de Entrada', async ({
  page,
}) => {
  let claimedBody;
  await mockCrm(page, {
    onHandoffClaim: (body) => (claimedBody = body),
    pendingHandoff: true,
  });
  await page.goto('/inbox');
  await page.evaluate(() => {
    globalThis.document.cookie = 'crm_csrf=csrf-test; Path=/; SameSite=Lax';
  });
  await expect(
    page.getByRole('heading', { name: 'Caixa de Entrada' }),
  ).toBeFocused();
  await expect(
    page
      .locator('.inbox-list .conv-next-action')
      .getByText('Assumir atendimento'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Handoffs pendentes' }),
  ).toHaveCount(0);
  // PCX-15: the only primary is in the header; its reason is beside the chat.
  const actions = page.locator('.conv-actions');
  await expect(page.locator('.handoff-reason')).toContainText(
    'Aguardando vendedor',
  );
  await expect(page.locator('.handoff-reason')).toContainText(
    'Esperando um vendedor assumir.',
  );
  await expect(
    page
      .locator('.inbox-composer')
      .getByRole('button', { name: 'Assumir atendimento' }),
  ).toHaveCount(0);
  await actions.getByRole('button', { name: 'Assumir atendimento' }).click();
  await expect(
    page.getByText('Atendimento de Studio Malu assumido.', { exact: true }),
  ).toBeVisible();
  expect(claimedBody).toEqual({
    expectedConversationVersion: 3,
    expectedHandoffVersion: 1,
    reasonCode: 'handoff_claimed',
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('PCX-15: takes the conversation from its header by keyboard, once, and lands on the reply', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  /** @type {any[]} */
  const claims = [];
  /** @type {() => void} */
  let release = () => {};
  const claimGate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await mockCrm(page, {
    claimGate,
    claimTakesOver: true,
    onHandoffClaim: (body) => claims.push(body),
    pendingHandoff: true,
  });
  await page.goto('/inbox/conversation-1');
  await page.evaluate(() => {
    globalThis.document.cookie = 'crm_csrf=csrf-test; Path=/; SameSite=Lax';
  });
  const conversation = page.locator('.inbox-conversation');
  const composer = page.locator('.inbox-composer');
  const takeOver = page.locator('.conv-actions').getByRole('button', {
    name: 'Assumir atendimento',
  });
  // Before: one primary action in the whole conversation, in the header.
  await expect(takeOver).toBeInViewport({ ratio: 1 });
  await expect(conversation.locator('.primary')).toHaveCount(1);
  await expect(page.getByLabel('Responder')).toHaveCount(0);
  await expect(takeOver).toHaveAccessibleDescription(
    'Aguardando vendedor Esperando um vendedor assumir.',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // A second Enter while the claim is in flight sends nothing more.
  await takeOver.focus();
  await page.keyboard.press('Enter');
  await expect(takeOver).toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Enter');
  await expect(takeOver).toBeFocused();
  release();

  // After: the reply takes its place and the focus; the outcome is announced.
  const reply = page.locator('#reply');
  await expect(reply).toBeFocused();
  await expect(reply).toBeEnabled();
  await expect(
    page.locator('.inbox-pane-notices').getByRole('status'),
  ).toHaveText('Atendimento de Studio Malu assumido.');
  await expect(takeOver).toHaveCount(0);
  await expect(conversation.locator('.primary')).toHaveCount(1);
  await expect(
    composer.getByRole('button', { name: 'Enviar resposta' }),
  ).toHaveClass(/primary/u);
  expect(claims).toEqual([
    {
      expectedConversationVersion: 3,
      expectedHandoffVersion: 1,
      reasonCode: 'handoff_claimed',
    },
  ]);
  await expect(page.getByRole('button', { name: /Devolver/u })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('labels human and AI service distinctly and only permits transfer after takeover', async ({
  page,
}) => {
  await mockCrm(page);
  await page.goto('/inbox');
  // PCX-15: the operational line tells the seller what to do next.
  await expect(
    page.locator('.inbox-list .conv-next-action', {
      hasText: 'Responder cliente',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Mais ações' }).click();
  await expect(
    page.getByRole('button', { name: 'Transferir atendimento' }),
  ).toBeVisible();

  await mockCrm(page, { assistant: true, assistantKeepsOwner: true });
  await page.reload();
  await expect(
    page.locator('.inbox-list .conv-next-action', { hasText: 'Com o agente' }),
  ).toBeVisible();
  await expect(page.locator('.conv-identity')).not.toContainText('Você');
  await page.getByRole('button', { name: 'Mais ações' }).click();
  await expect(
    page.getByRole('button', { name: 'Transferir atendimento' }),
  ).toHaveCount(0);
});

test('never offers to hand the conversation back to the AI and keeps the actions on the keyboard', async ({
  page,
}) => {
  // ADR 015: a conversation with a person never goes back to the bot.
  /** @type {string[]} */
  const handBackRequests = [];
  page.on('request', (request) => {
    if (/return-to-ai|reactivate/u.test(request.url())) {
      handBackRequests.push(request.url());
    }
  });
  await mockCrm(page);
  await page.goto('/inbox');
  const actions = page.locator('.conv-actions');
  // PCX-11: the owner of a conversation with no order is offered to create it.
  const createOrder = actions.getByRole('button', { name: 'Criar pedido' });
  await expect(createOrder).toBeVisible();
  await expect(page.getByRole('button', { name: /Devolver/ })).toHaveCount(0);
  await expect(page.getByText(/à IA/u)).toHaveCount(0);

  // Achado 1: two visible actions and the rest under "Mais", in one tab
  // sequence with no gap where the removed button was. PCX-13: "Encerrar
  // conversa" left the header for "Mais" and no primary sits here.
  await createOrder.focus();
  for (const name of ['Mais ações', 'Detalhes do atendimento']) {
    await page.keyboard.press('Tab');
    await expect(actions.getByRole('button', { name })).toBeFocused();
  }
  await expect(actions.locator('button:visible')).toHaveCount(3);
  await expect(actions.locator('button.primary')).toHaveCount(0);
  await expect(
    actions.locator(':scope > button', { hasText: 'Encerrar conversa' }),
  ).toHaveCount(0);

  // "Mais" opens from the keyboard on its first entry; Esc hands focus back.
  const more = actions.getByRole('button', { name: 'Mais ações' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(
    actions.getByRole('button', { name: 'Transferir atendimento' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    actions.getByRole('button', { name: 'Arquivar conversa' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(
    actions.getByRole('button', { name: 'Encerrar conversa' }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(
    actions.getByRole('button', { name: 'Transferir atendimento' }),
  ).toBeHidden();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Transferir atendimento para')).toBeFocused();
  // INBOX-UX-03: contact data opens from the person's name.
  await page.getByRole('button', { name: 'Dados de Studio Malu' }).click();
  await expect(
    page
      .getByRole('dialog', { name: 'Cadastro' })
      .getByRole('link', { name: 'Ver contato' }),
  ).toHaveAttribute('href', '/clientes/contact-1');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // With the agent or waiting for a seller, taking over remains the only primary.
  for (const state of [{ assistant: true }, { pendingHandoff: true }]) {
    await mockCrm(page, state);
    await page.reload();
    await expect(
      actions.getByRole('button', { name: 'Assumir atendimento' }),
    ).toBeVisible();
    await expect(
      page
        .locator('.inbox-composer')
        .getByRole('button', { name: 'Assumir atendimento' }),
    ).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Devolver/ })).toHaveCount(0);
  }
  expect(handBackRequests).toEqual([]);
});

test('keeps a long conversation inside its own scrollable message area', async ({
  page,
}) => {
  await mockCrm(page, { longThread: true });
  await page.goto('/inbox');
  const metrics = await page.locator('.thread').evaluate((element) => ({
    clientHeight: element.clientHeight,
    overflowY: globalThis.getComputedStyle(element).overflowY,
    scrollHeight: element.scrollHeight,
  }));

  expect(metrics.overflowY).toBe('auto');
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
});

test('keeps a long conversation list inside its own scrollable column', async ({
  page,
}) => {
  await mockCrm(page, { manyConversations: true });
  await page.goto('/inbox');
  await expect(page.locator('.inbox-list .conversation-row')).toHaveCount(40);
  const listMetrics = () =>
    page.locator('.inbox-list').evaluate((element) => {
      const root = globalThis.document.documentElement;
      // Scrolled to the bottom of the page, where the top bar overlaps most.
      globalThis.scrollTo(0, root.scrollHeight);
      return {
        clientHeight: element.clientHeight,
        listTop: element.getBoundingClientRect().top,
        overflowY: globalThis.getComputedStyle(element).overflowY,
        pageHeight: root.scrollHeight,
        scrollHeight: element.scrollHeight,
        topbarBottom: globalThis.document
          .querySelector('.app-topbar')
          ?.getBoundingClientRect().bottom,
        viewportHeight: globalThis.innerHeight,
      };
    });

  for (const viewport of [
    { height: 720, width: 1280 },
    { height: 844, width: 390 },
  ]) {
    await page.setViewportSize(viewport);
    const metrics = await listMetrics();
    expect(metrics.overflowY).toBe('auto');
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.clientHeight).toBeLessThan(metrics.viewportHeight);
    // The page no longer grows with the list it holds.
    expect(metrics.pageHeight).toBeLessThan(metrics.scrollHeight);
    if (viewport.width >= 1200) {
      // Beside the thread, the list stays fully below the sticky top bar.
      expect(metrics.listTop).toBeGreaterThanOrEqual(
        Number(metrics.topbarBottom),
      );
    }
  }
  await page.evaluate(() => globalThis.scrollTo(0, 0));

  const lastConversation = page.getByRole('button', {
    name: /Cliente de teste 40/u,
  });
  await lastConversation.focus();
  await expect(lastConversation).toBeInViewport();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('identifies customer, assistant, and seller messages in the conversation', async ({
  page,
}) => {
  await mockCrm(page, { mixedAuthors: true });
  await page.goto('/inbox');

  await expect(
    page.locator(".message[data-from='cliente'] .msg-role"),
  ).toHaveCount(0);
  await expect(
    page.locator(".message[data-from='cliente'] .msg-author"),
  ).toHaveText('Studio Malu');
  // Glossário (achado 5): one name for the assistant, from the brand.
  await expect(
    page.locator(".message[data-from='agente'] .msg-author"),
  ).toHaveText('Agente');
  await expect(
    page.locator(".message[data-from='agente'] .msg-role"),
  ).toHaveText('IA');
  await expect(
    page.locator(".message[data-from='humano'] .msg-author"),
  ).toHaveText('Vendedor');
  await expect(page.getByText('Assistente Silmer')).toHaveCount(0);
  await expect(page.getByText('Entrega: sent')).toHaveCount(0);
});

test('shows a failed delivery code to the seller in the Inbox', async ({
  page,
}) => {
  await mockCrm(page, { failedDelivery: true, mixedAuthors: true });
  await page.goto('/inbox');
  await expect(
    page.getByText('O envio encontrou um problema', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('N8N_COMMAND_HTTP_401')).not.toBeVisible();
  await page.getByText('Detalhes para suporte', { exact: true }).press('Enter');
  await expect(page.getByText('N8N_COMMAND_HTTP_401')).toBeVisible();
  await expect(page.getByText('message-human', { exact: true })).toBeVisible();
});

/** INBOX-DELIVERY-01: fault/late-callback scenarios, using synthetic messages only.
 * @param {import('@playwright/test').Page} page
 * @param {(call: number) => Promise<string>|string} status
 */
async function mockDeliveryCheck(page, status) {
  await mockCrm(page, { mixedAuthors: true, manyConversations: true });
  let calls = 0;
  await page.route(
    '**/api/v1/inbox/conversations/conversation-1',
    async (route) => {
      // Initial loading and live reconnection can both read the detail. Only
      // the user's explicit check advances this synthetic provider response.
      const checking = await page
        .getByRole('button', { name: 'Verificando…', exact: true })
        .count();
      const deliveryStatus = checking
        ? await status(++calls)
        : 'outcome_unknown';
      if (deliveryStatus === 'unavailable') {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: '{}',
        });
        return;
      }
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          conversation,
          messages: [
            {
              ...conversation.lastMessage,
              id: 'message-human',
              authorKind: 'human',
              direction: 'outbound',
              preview: 'Mensagem sintética em verificação.',
              deliveryStatus,
              deliveryErrorCode:
                deliveryStatus === 'outcome_unknown'
                  ? 'N8N_COMMAND_TIMEOUT'
                  : null,
            },
          ],
          suggestion: null,
        }),
      });
    },
  );
}

test('INBOX-DELIVERY-01: uncertain send is traceable and checks without sending', async ({
  page,
}) => {
  await mockDeliveryCheck(page, () => 'outcome_unknown');
  /** @type {string[]} */
  const writes = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.goto('/inbox');
  await expect(
    page.getByText('Ainda não conseguimos confirmar o envio'),
  ).toBeVisible();
  await expect(
    page.getByText(/Verifique o envio antes de repetir/u),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Verificar envio', exact: true })
    .press('Enter');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Ainda não há confirmação do envio.' }),
  ).toContainText('Ainda não há confirmação do envio.');
  await expect(
    page.getByRole('button', { name: 'Verificar envio', exact: true }),
  ).toBeFocused();
  await page.getByText('Detalhes para suporte', { exact: true }).press('Enter');
  await expect(page.getByText('message-human', { exact: true })).toBeVisible();
  await expect(
    page.getByText('N8N_COMMAND_TIMEOUT', { exact: true }),
  ).toBeVisible();
  expect(writes).toEqual([]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('INBOX-DELIVERY-01: failed status check preserves history and can be tried again', async ({
  page,
}) => {
  let failCheck = false;
  await mockDeliveryCheck(page, () =>
    failCheck ? 'unavailable' : 'outcome_unknown',
  );
  await page.goto('/inbox');
  await page
    .getByRole('textbox', { name: 'Responder', exact: true })
    .fill('Rascunho preservado');
  failCheck = true;
  await page
    .getByRole('button', { name: 'Verificar envio', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível verificar o envio agora.',
  );
  await expect(
    page.getByText('Mensagem sintética em verificação.'),
  ).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toHaveValue('Rascunho preservado');
  failCheck = false;
  await page
    .getByRole('button', { name: 'Tentar novamente', exact: true })
    .press('Enter');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Ainda não há confirmação do envio.' }),
  ).toContainText('Ainda não há confirmação do envio.');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('INBOX-DELIVERY-01: late confirmation removes warning and restores keyboard focus', async ({
  page,
}) => {
  let deliveryStatus = 'outcome_unknown';
  await mockDeliveryCheck(page, () => deliveryStatus);
  await page.goto('/inbox');
  await expect(
    page.getByRole('button', { name: 'Verificar envio', exact: true }),
  ).toBeVisible();
  deliveryStatus = 'delivered';
  await page
    .getByRole('button', { name: 'Verificar envio', exact: true })
    .press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Mensagem entregue.' }),
  ).toContainText('Mensagem entregue.');
  await expect(
    page.getByRole('button', { name: 'Verificar envio', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Histórico da conversa' }),
  ).toBeFocused();
});

test('INBOX-DELIVERY-01: pending check cannot duplicate or update another conversation', async ({
  page,
}) => {
  let checking = false;
  let checks = 0;
  let finished = false;
  /** @type {(value: string) => void} */
  let release = () => {};
  /** @type {Promise<string>} */
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await mockDeliveryCheck(page, async () => {
    if (!checking) return 'outcome_unknown';
    checks++;
    const result = await gate;
    finished = true;
    return result;
  });
  await page.route('**/api/v1/inbox/conversations/conversation-2', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        conversation: {
          ...conversation,
          id: 'conversation-2',
          contact: {
            ...conversation.contact,
            label: 'Outro atendimento sintético',
          },
        },
        messages: [],
        suggestion: null,
      }),
    }),
  );
  await page.goto('/inbox');
  await expect(
    page.getByRole('button', { name: 'Verificar envio', exact: true }),
  ).toBeVisible();
  checking = true;
  await page
    .getByRole('button', { name: 'Verificar envio', exact: true })
    .press('Enter');
  const pendingButton = page.getByRole('button', {
    name: 'Verificando…',
    exact: true,
  });
  await expect(pendingButton).toHaveAttribute('aria-disabled', 'true');
  await pendingButton.press('Enter');
  await page.getByRole('button', { name: /Cliente de teste 2\s/u }).click();
  await expect(
    page.getByRole('heading', {
      name: 'Outro atendimento sintético',
      exact: true,
    }),
  ).toBeVisible();
  release('delivered');
  await expect.poll(() => finished).toBe(true);
  expect(checks).toBe(1);
  await expect(
    page.getByText('Mensagem sintética em verificação.'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Mensagem entregue.' }),
  ).toHaveCount(0);
});

test('shows the declared site phone instead of the synthetic chat ID', async ({
  page,
}) => {
  await mockCrm(page, { siteChat: true });
  await page.goto('/inbox');
  await page.getByRole('button', { name: 'Dados de Studio Malu' }).click();
  const profile = page.getByRole('dialog', { name: 'Cadastro' });
  await expect(profile).toContainText(
    /\+55 \(27\) 99999-1234\s*(?:·\s*)?telefone informado no site/u,
  );
  await expect(
    page.getByText('999001899004479995964365389745407152128'),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('#inbox-search').fill('5527999991234');
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/u }),
  ).toBeVisible();
});

test('restores search focus after removing filter controls', async ({
  page,
}) => {
  await mockCrm(page);

  await page.goto('/clientes');
  const clientSearch = page.locator('#client-search');
  await clientSearch.fill('inexistente');
  const clearClientSearch = page.getByRole('button', {
    name: 'Limpar busca',
  });
  await clearClientSearch.focus();
  await clearClientSearch.press('Enter');
  await expect(clientSearch).toBeFocused();

  await page.goto('/inbox');
  const inboxSearch = page.locator('#inbox-search');
  await inboxSearch.fill('inexistente');
  const clearInboxSearch = page.getByRole('button', {
    name: 'Limpar busca',
  });
  await clearInboxSearch.focus();
  await clearInboxSearch.press('Enter');
  await expect(inboxSearch).toBeFocused();
});

test('refreshes the Inbox manually when live updates fail and keeps focus on live refresh', async ({
  page,
}) => {
  const inboxQueries = /** @type {Array<Record<string, string>>} */ ([]);
  await page.addInitScript(() => {
    const testGlobal = /** @type {any} */ (globalThis);
    class FakeEventSource extends globalThis.EventTarget {
      constructor() {
        super();
        testGlobal.__inboxSource = this;
      }
      close() {}
    }
    testGlobal.EventSource = FakeEventSource;
  });
  await mockCrm(page, {
    // The tab totals (`limit=1`) ride along; only the list reads count here.
    onInboxList: (params) => {
      if (params.get('limit') !== '1') {
        inboxQueries.push(Object.fromEntries(params));
      }
    },
  });
  await page.goto('/inbox');
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
  // PCX-15: owner filtering stays available in the sheet across reconnects.
  await selectInboxFilters(page, 'Todas', 'Minhas');
  await expect
    .poll(() => inboxQueries.at(-1)?.assignedUserId)
    .toBe('operator-1');

  await page.evaluate(() => {
    /** @type {any} */ (globalThis).__inboxSource.dispatchEvent(
      new globalThis.Event('error'),
    );
  });
  await expect(page.getByText(/Reconectando atualizações/)).toBeVisible();
  const manualRefresh = page.getByRole('button', {
    name: 'Atualizar conversas',
  });
  await manualRefresh.click();
  await expect.poll(() => inboxQueries.length).toBeGreaterThan(2);
  expect(inboxQueries.at(-1)?.assignedUserId).toBe('operator-1');

  const search = page.locator('#inbox-search');
  await search.focus();
  const beforeReconnect = inboxQueries.length;
  await page.evaluate(() => {
    /** @type {any} */ (globalThis).__inboxSource.dispatchEvent(
      new globalThis.Event('open'),
    );
  });
  await expect.poll(() => inboxQueries.length).toBeGreaterThan(beforeReconnect);
  expect(inboxQueries.at(-1)?.assignedUserId).toBe('operator-1');
  await expect(search).toBeFocused();
  await expect(page.getByText(/Reconectando atualizações/)).toHaveCount(0);

  const beforeEvent = inboxQueries.length;
  await page.evaluate(() => {
    /** @type {any} */ (globalThis).__inboxSource.dispatchEvent(
      new globalThis.MessageEvent('inbox.conversation.changed', {
        data: JSON.stringify({ conversationId: 'conversation-1' }),
      }),
    );
  });
  await expect.poll(() => inboxQueries.length).toBeGreaterThan(beforeEvent);
  await expect(search).toBeFocused();
});

test('finds a new last message after the live event without moving search focus', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const testGlobal = /** @type {any} */ (globalThis);
    class FakeEventSource extends globalThis.EventTarget {
      constructor() {
        super();
        testGlobal.__inboxSource = this;
      }
      close() {}
    }
    testGlobal.EventSource = FakeEventSource;
  });
  await mockCrm(page, { newMessageOnRefresh: true });
  await page.goto('/inbox');
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
  const search = page.locator('#inbox-search');
  await expect(page.locator('#inbox-search-help')).toContainText(
    'até 100 conversas carregadas',
  );
  await search.fill('Mensagem nova');
  await expect(search).toBeFocused();
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toHaveCount(0);

  await page.evaluate(() => {
    /** @type {any} */ (globalThis).__inboxSource.dispatchEvent(
      new globalThis.MessageEvent('inbox.conversation.changed', {
        data: JSON.stringify({ conversationId: 'conversation-1' }),
      }),
    );
  });
  // The refreshed message is searchable even though the compact card omits
  // its preview. Its appearance under this query proves the updated match.
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
  await expect(page.locator('.inbox-list .conv-snippet')).toHaveCount(0);
  await expect(search).toBeFocused();
});

/**
 * PCX-14: what a person can reach and use in the Inbox without scrolling,
 * outside the app navigation (design.md §16, "Metas de controles").
 *
 * @param {import('@playwright/test').Page} page
 */
function firstScreenControls(page) {
  return page.evaluate(() => {
    const viewport = {
      height: globalThis.innerHeight,
      width: globalThis.innerWidth,
    };
    return [
      ...globalThis.document.querySelectorAll(
        '#main-content :is(a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]))',
      ),
    ].filter((element) => {
      const box = element.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < viewport.height &&
        box.left < viewport.width &&
        globalThis.getComputedStyle(element).visibility !== 'hidden' &&
        !element.closest('dialog:not([open])')
      );
    }).length;
  });
}

test('PCX-14: filters the Inbox with three shortcuts with totals and the "Filtros" sheet', async ({
  page,
}) => {
  const inboxQueries = /** @type {Array<Record<string, string>>} */ ([]);
  const countQueries = /** @type {Array<Record<string, string>>} */ ([]);
  await mockCrm(page, {
    onInboxList: (params) =>
      (params.get('limit') === '1' ? countQueries : inboxQueries).push(
        Object.fromEntries(params),
      ),
  });
  await page.goto('/inbox');

  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  /** @param {string} name */
  const shortcut = (name) =>
    shortcuts.getByRole('button', { name: new RegExp(`^${name}`, 'u') });
  const filters = page.getByRole('button', { name: /^Filtros/u });

  // PCX-01: the old conversation-state filter is gone. "Situação" only
  // names a group of the closed sheet (PCX-14), never a control on the list.
  await expect(page.getByText('Situação', { exact: true })).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Requer atenção' }),
  ).toHaveCount(0);
  // PCX-15: the filters give way to the search, three
  // shortcuts with their totals and "Filtros": five controls, not seven.
  await expect(shortcuts.getByRole('button')).toHaveText([
    /^Atender\s*1$/u,
    /^Fechar pedidos\s*0$/u,
    /^Todas\s*1$/u,
  ]);
  await expect(page.locator('.inbox-toolbar select')).toHaveCount(0);
  await expect(page.locator('#inbox-queue')).toHaveCount(0);
  await expect(page.locator('.inbox-toolbar button:visible')).toHaveCount(4);
  await expect(page.locator('#inbox-search')).toBeVisible();
  await expect(shortcut('Atender')).toHaveAttribute('aria-pressed', 'true');
  await expect(filters).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(filters).toHaveAccessibleName('Filtros');
  // The totals of the other two shortcuts: one `limit=1` read each, with the
  // same API filters the list uses.
  expect(countQueries.slice(0, 2)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ archived: 'false', workQueue: 'closing' }),
      expect.objectContaining({ archived: 'false', limit: '1' }),
    ]),
  );

  // PCX-05: owner and waiting filters remain available without extra shortcuts.
  await selectInboxFilters(page, 'Todas', 'Minhas');
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ archived: 'false', assignedUserId: 'operator-1' });
  expect(inboxQueries.at(-1)?.workQueue).toBeUndefined();
  await expect(shortcut('Todas')).toHaveAttribute('aria-pressed', 'false');
  await selectInboxFilters(page, 'Aguardando vendedor', 'Todas');
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ archived: 'false', pendingHandoff: 'true' });
  expect(inboxQueries.at(-1)?.automationState).toBeUndefined();
  expect(inboxQueries.at(-1)?.assignedUserId).toBeUndefined();

  // The sheet opens from the keyboard on the filters in use.
  await filters.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Filtrar conversas' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('legend')).toHaveText(['Situação', 'Responsável']);
  const situation = sheet.getByRole('group', { name: 'Situação' });
  const owner = sheet.getByRole('group', { name: 'Responsável' });
  await expect(situation.getByRole('radio')).toHaveCount(7);
  await expect(situation.locator('label')).toHaveText([
    'Todas',
    'Atender',
    'Fechar pedidos',
    'Aguardando vendedor',
    'Com o agente',
    'Com vendedor',
    'Arquivadas',
  ]);
  await expect(owner.locator('label')).toHaveText([
    'Todas',
    'Minhas',
    'Sem responsável',
  ]);
  const waiting = situation.getByRole('radio', { name: 'Aguardando vendedor' });
  await expect(waiting).toBeFocused();
  await expect(waiting).toBeChecked();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Arrows change the option, Tab moves to the next group and on to the
  // footer; "Ver resultados" applies both at once.
  await page.keyboard.press('ArrowDown');
  await expect(
    situation.getByRole('radio', { name: 'Com o agente' }),
  ).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(owner.getByRole('radio', { name: 'Todas' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(
    owner.getByRole('radio', { name: 'Sem responsável' }),
  ).toBeChecked();
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
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({
      automationState: 'assistant',
      pendingHandoff: 'false',
      unassignedHumanHandoff: 'true',
    });
  expect(inboxQueries.at(-1)?.assignedUserId).toBeUndefined();

  // A pair no shortcut covers: no shortcut pressed, "Filtros" says how many
  // are on and the summary names each one with a way to remove it.
  for (const name of ['Atender', 'Fechar pedidos', 'Todas']) {
    await expect(shortcut(name)).toHaveAttribute('aria-pressed', 'false');
  }
  await expect(filters).toHaveAccessibleName('Filtros 2 ativos');
  const summary = page.getByRole('group', { name: 'Filtro:' });
  await expect(summary.getByRole('button')).toHaveText([
    'Com o agente',
    'Sem responsável',
    'Limpar filtros',
  ]);
  await expect(
    summary.getByRole('button', { name: 'Remover filtro Com o agente' }),
  ).toBeVisible();

  // Esc leaves the list as it was.
  const before = inboxQueries.length;
  await page.keyboard.press('Enter');
  await expect(sheet).toBeVisible();
  await expect(
    situation.getByRole('radio', { name: 'Com o agente' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  expect(inboxQueries).toHaveLength(before);
  await expect(filters).toHaveAccessibleName('Filtros 2 ativos');

  // PCX-02: "Com vendedor", still combined with the owner already chosen.
  await filters.click();
  await situation.getByText('Com vendedor', { exact: true }).click();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({
      automationState: 'human',
      pendingHandoff: 'false',
      unassignedHumanHandoff: 'true',
    });

  // PCX-05: the archived conversations are reached from the sheet.
  await filters.click();
  await situation.getByText('Arquivadas', { exact: true }).click();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ archived: 'true', unassignedHumanHandoff: 'true' });
  expect(inboxQueries.at(-1)?.automationState).toBeUndefined();
  expect(inboxQueries.at(-1)?.pendingHandoff).toBeUndefined();

  // Removing one filter keeps the other, and the focus, in the summary.
  await summary
    .getByRole('button', { name: 'Remover filtro Sem responsável' })
    .click();
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ archived: 'true' });
  expect(inboxQueries.at(-1)?.unassignedHumanHandoff).toBeUndefined();
  await expect(summary.getByRole('button')).toHaveText(['Arquivadas']);
  await expect(
    summary.getByRole('button', { name: 'Remover filtro Arquivadas' }),
  ).toBeFocused();
  await expect(filters).toHaveAccessibleName('Filtros 1 ativo');

  // The last one gone, the list is every conversation and "Filtros" has the
  // focus.
  await page.keyboard.press('Enter');
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ archived: 'false' });
  await expect(summary).toHaveCount(0);
  await expect(shortcut('Todas')).toHaveAttribute('aria-pressed', 'true');
  await expect(filters).toBeFocused();
  await expect(filters).toHaveAccessibleName('Filtros');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('PCX-14: on a 390 px phone the shortcuts fit, the sheet works by keyboard and the first screen keeps its budget', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCrm(page);
  await page.goto('/inbox');
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  await expect(shortcuts.getByRole('button')).toHaveText([
    /^Atender\s*1$/u,
    /^Fechar pedidos\s*0$/u,
    /^Todas\s*1$/u,
  ]);
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();

  // Every shortcut whole on screen: no sideways scroll, nothing cut.
  const layout = await page.evaluate(() => {
    const doc = globalThis.document.documentElement;
    const row = /** @type {HTMLElement} */ (
      globalThis.document.querySelector('.inbox-tabs')
    );
    return {
      overflow: doc.scrollWidth - doc.clientWidth,
      rowOverflow: row.scrollWidth - row.clientWidth,
    };
  });
  expect(layout.overflow).toBeLessThanOrEqual(0);
  expect(layout.rowOverflow).toBeLessThanOrEqual(0);
  const filters = page.getByRole('button', { name: /^Filtros/u });
  for (const control of [
    ...(await shortcuts.getByRole('button').all()),
    filters,
  ]) {
    await expect(control).toBeInViewport({ ratio: 1 });
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator('#inbox-search')).toBeInViewport();
  // design.md §16: at most 15 controls on the first screen of a phone.
  expect(await firstScreenControls(page)).toBeLessThanOrEqual(15);

  // The sheet: 44 px options, the option in use first, Esc back to "Filtros".
  await filters.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Filtrar conversas' });
  await expect(sheet).toBeVisible();
  const situation = sheet.getByRole('group', { name: 'Situação' });
  await expect(
    situation.getByRole('radio', { name: 'Atender', exact: true }),
  ).toBeFocused();
  for (const option of await sheet.locator('.filter-sheet-option').all()) {
    expect((await option.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  for (const button of await sheet.getByRole('button').all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('ArrowDown');
  await expect(
    situation.getByRole('radio', { name: 'Fechar pedidos' }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect(
    shortcuts.getByRole('button', { name: /^Atender/u }),
  ).toHaveAttribute('aria-pressed', 'true');

  // A pair outside the shortcuts: the summary sits under them, targets intact.
  await page.keyboard.press('Enter');
  await situation.getByText('Com o agente', { exact: true }).click();
  await sheet
    .getByRole('group', { name: 'Responsável' })
    .getByText('Sem responsável', { exact: true })
    .click();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
  const summary = page.getByRole('group', { name: 'Filtro:' });
  for (const button of await summary.getByRole('button').all()) {
    await expect(button).toBeInViewport();
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  expect(await firstScreenControls(page)).toBeLessThanOrEqual(15);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // design.md §16: at most 24 on a 1366×768 notebook.
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/inbox');
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
  await expect(page.locator('.conv-head')).toBeVisible();
  expect(await firstScreenControls(page)).toBeLessThanOrEqual(24);
});

test.describe('on a touch tablet', () => {
  test.use({ hasTouch: true, viewport: { height: 1180, width: 820 } });

  test('PCX-14: the shortcuts and "Filtros" are 44 px targets with 8 px between them (design.md §4)', async ({
    page,
  }) => {
    await mockCrm(page);
    await page.goto('/inbox');
    // The contract is about the pointer, not the width: 820 px is wider
    // than the phone layout, and the screen is still touched.
    expect(
      await page.evaluate(
        () => globalThis.matchMedia('(pointer: coarse)').matches,
      ),
    ).toBe(true);
    const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
    await expect(shortcuts.getByRole('button')).toHaveText([
      /^Atender\s*1$/u,
      /^Fechar pedidos\s*0$/u,
      /^Todas\s*1$/u,
    ]);
    const buttons = await shortcuts.getByRole('button').all();
    const filters = page.getByRole('button', { name: /^Filtros/u });
    // Full labels can wrap on a phone; targets stay whole and separated.
    for (const viewport of [null, { height: 844, width: 390 }]) {
      if (viewport) await page.setViewportSize(viewport);
      for (const control of [...buttons, filters]) {
        await expect(control).toBeInViewport({ ratio: 1 });
        expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(
          44,
        );
      }
      for (let index = 1; index < buttons.length; index += 1) {
        const before = await buttons[index - 1].boundingBox();
        const after = await buttons[index].boundingBox();
        if (!before || !after) throw new Error('Shortcuts must be visible');
        expect(
          after.y >= before.y + before.height
            ? after.y - (before.y + before.height)
            : after.x - (before.x + before.width),
        ).toBeGreaterThanOrEqual(8);
      }
      const rowOverflow = await page
        .locator('.inbox-tabs')
        .evaluate((row) => row.scrollWidth - row.clientWidth);
      expect(rowOverflow).toBeLessThanOrEqual(0);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    }
  });
});

test('PCX-15: the Painel links retain owner and waiting filters in the summary', async ({
  page,
}) => {
  const inboxQueries = /** @type {Array<Record<string, string>>} */ ([]);
  await mockCrm(page, {
    onInboxList: (params) => {
      if (params.get('limit') !== '1') {
        inboxQueries.push(Object.fromEntries(params));
      }
    },
  });
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  /** @param {string} name */
  const shortcut = (name) =>
    shortcuts.getByRole('button', { name: new RegExp(`^${name}`, 'u') });
  const summary = page.getByRole('group', { name: 'Filtro:' });

  await page.goto('/inbox?fila=minhas');
  await expect(shortcuts.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(summary.getByRole('button')).toHaveText(['Minhas']);
  await expect(shortcut('Todas')).toHaveAttribute('aria-pressed', 'false');
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ assignedUserId: 'operator-1' });

  await page.goto('/inbox?situacao=aguardando');
  await expect(shortcuts.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(summary.getByRole('button')).toHaveText(['Aguardando vendedor']);
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({ pendingHandoff: 'true' });

  // A link outside the shortcuts opens with its filters in the summary.
  await page.goto('/inbox?situacao=agente&fila=sem-responsavel');
  await expect(summary.getByRole('button')).toHaveText([
    'Com o agente',
    'Sem responsável',
    'Limpar filtros',
  ]);
  await expect
    .poll(() => inboxQueries.at(-1))
    .toMatchObject({
      automationState: 'assistant',
      unassignedHumanHandoff: 'true',
    });

  // An unknown value is ignored, without an error.
  await page.goto('/inbox?situacao=inventada&fila=outra');
  await expect(shortcut('Todas')).toHaveAttribute('aria-pressed', 'true');
  await expect(summary).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
});

test('PCX-14: an empty filter is not an empty Inbox and offers "Limpar filtros"', async ({
  page,
}) => {
  await mockCrm(page, {
    emptyWhen: (params) => params.get('pendingHandoff') === 'true',
  });
  await page.goto('/inbox');
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  const list = page.getByRole('list', { name: 'Conversas' });
  // The count is the API's answer: 0 waiting, not a hidden number.
  await expect(shortcuts.getByRole('button')).toHaveText([
    /^Atender\s*1$/u,
    /^Fechar pedidos\s*0$/u,
    /^Todas\s*1$/u,
  ]);

  await selectInboxFilters(page, 'Aguardando vendedor');
  await expect(
    list.getByRole('heading', { name: 'Nenhuma conversa com esse filtro' }),
  ).toBeVisible();
  const clear = list.getByRole('button', { name: 'Limpar filtros' });
  await expect(clear).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await clear.focus();
  await page.keyboard.press('Enter');
  await expect(list.getByRole('button', { name: /Studio Malu/ })).toBeVisible();
  await expect(
    shortcuts.getByRole('button', { name: /^Todas/u }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /^Filtros/u })).toBeFocused();

  // An Inbox with no conversation at all says so, with no filter to clear.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockCrm(page, { empty: true });
  await page.goto('/inbox?situacao=todas');
  await expect(
    list.getByRole('heading', { name: 'Nenhuma conversa por enquanto' }),
  ).toBeVisible();
  await expect(
    list.getByRole('button', { name: 'Limpar filtros' }),
  ).toHaveCount(0);
});

test('PCX-14: a total that fails to load is left out, never guessed', async ({
  page,
}) => {
  await mockCrm(page, {
    failInboxList: (params) =>
      params.get('limit') === '1' && params.get('workQueue') === 'closing',
  });
  await page.goto('/inbox');
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  await expect(shortcuts.getByRole('button')).toHaveText([
    /^Atender\s*1$/u,
    /^Fechar pedidos\s*$/u,
    /^Todas\s*1$/u,
  ]);
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
});

test('PCX-15: names the next action and waits oldest first, with stop reasons in the chat', async ({
  page,
}) => {
  await mockCrm(page, { waitingQueue: true });
  await page.goto('/inbox');

  // The waiting queue is still available through the situation filter.
  await selectInboxFilters(page, 'Aguardando vendedor');

  // PCX-04: the conversation waiting the longest leads, whatever order the
  // page happened to receive.
  await expect(page.locator('.inbox-list .conv-name')).toHaveText([
    'Time Fênix Futsal',
    'Studio Malu',
    'Igreja Nova Aliança',
  ]);

  // PCX-15: cards show one next action; technical/business stop reasons remain in the chat.
  await expect(page.locator('.inbox-list .conv-next-action')).toHaveText([
    'Assumir atendimento',
    'Assumir atendimento',
    'Assumir atendimento',
  ]);
  await expect(page.locator('.inbox-list .badge')).toHaveCount(0);

  // PCX-03/A02: how long it has been still, counted from the handoff.
  await expect(page.locator('.inbox-list .conv-waiting')).toHaveText([
    'Espera: 1d 03h',
    'Espera: 2h 14min',
    'Espera: 47min',
  ]);
  for (const [id, reason] of [
    ['conversation-2', 'Pediu um vendedor'],
    ['conversation-1', 'Perguntou o valor'],
    ['conversation-3', 'Pré-ficha completa'],
  ]) {
    await page
      .locator(`.conversation-row[data-conversation-id="${id}"]`)
      .click();
    await expect(page.locator('.handoff-reason')).toContainText(reason);
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('PCX-10: links the conversation header to its order, with the status in words', async ({
  page,
}) => {
  // PCX-10: the header names the order and its status; it is a link to the
  // order page, not a status dressed as a button.
  await mockCrm(page, { order: conversationOrder });
  await page.goto('/inbox');
  const head = page.locator('.conv-head');
  const link = head.getByRole('link', {
    name: 'Abrir pedido 07-CRM, pendente',
  });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    'href',
    '/pedidos/order-pendente?conversa=conversation-1',
  );
  await expect(link).toHaveAccessibleName('Abrir pedido 07-CRM, pendente');
  // The status is a word in a badge, never a colour alone.
  await expect(link.locator('.badge')).toHaveText('Pendente');
  await expect(head.getByRole('button', { name: /^Pedido/ })).toHaveCount(0);

  await mockCrm(page, {
    order: { ...conversationOrder, missingFields: [], status: 'confirmado' },
  });
  await page.reload();
  await expect(
    head.getByRole('link', { name: 'Abrir pedido 07-CRM, confirmado' }),
  ).toBeVisible();

  // No order: the header says nothing about it, and "Sem pedido" is said
  // once, in Detalhes › Pedido.
  await mockCrm(page, { order: null });
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Studio Malu' }),
  ).toBeVisible();
  await expect(head.getByRole('link', { name: /pedido/i })).toHaveCount(0);
  await page
    .locator('.conv-actions')
    .getByRole('button', { name: 'Detalhes do atendimento' })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Atendimento' })
      .getByRole('region', { name: 'Pedido', exact: true }),
  ).toContainText('Sem pedido nesta conversa.');
  await expect(
    page.getByText(/Sem pedido/).filter({ visible: true }),
  ).toHaveCount(1);
});

test('PCX-10: updates the order link when the order changes elsewhere', async ({
  page,
}) => {
  // PLI-08: the confirmation happened on the order page, in another tab. The
  // Inbox learns it from `inbox.order.changed`, with nobody reloading.
  await mockCrm(page, {
    confirmOnRefresh: true,
    liveEvent: {
      payload: {
        conversationId: 'conversation-1',
        orderId: 'order-pendente',
      },
      type: 'inbox.order.changed',
    },
    order: conversationOrder,
  });
  await page.goto('/inbox');

  const link = page
    .locator('.conv-head')
    .getByRole('link', { name: 'Abrir pedido 07-CRM, confirmado' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute(
    'href',
    '/pedidos/order-pendente?conversa=conversation-1',
  );
  expect(page.url()).toContain('/inbox');
  // Detalhes › Pedido reads the same, confirmed order.
  await page
    .locator('.conv-actions')
    .getByRole('button', { name: 'Detalhes do atendimento' })
    .click();
  await expect(
    page
      .getByRole('dialog', { name: 'Atendimento' })
      .getByRole('region', { name: 'Pedido', exact: true })
      .locator('.badge'),
  ).toHaveText('Confirmado');
});

test('PCX-12: summarises the order in Detalhes, opened and closed from the keyboard', async ({
  page,
}) => {
  await mockCrm(page, { order: conversationOrder });
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/inbox');

  // Enter opens the overlay and focuses its close control.
  const toggle = page
    .locator('.conv-actions')
    .getByRole('button', { name: 'Detalhes do atendimento' });
  await toggle.focus();
  await page.keyboard.press('Enter');
  const context = page.getByRole('dialog', { name: 'Atendimento' });
  await expect(context).toBeVisible();
  await expect(
    context.getByRole('heading', { level: 2, name: 'Atendimento' }),
  ).toBeVisible();
  await expect(
    context.getByRole('button', { name: 'Recolher detalhes' }),
  ).toBeFocused();

  // PCX-12: number, status, what is missing, items, pieces, amount and the
  // one way out of the summary and into the order itself.
  const summary = context.getByRole('region', { name: 'Pedido', exact: true });
  await expect(summary).toContainText('07-CRM');
  await expect(summary).toContainText('Pendente');
  await summary.locator('summary', { hasText: 'Pendências do pedido' }).click();
  await expect(
    summary.getByRole('listitem').filter({ hasText: /^valor final$/u }),
  ).toBeVisible();
  await expect(
    summary.getByRole('listitem').filter({ hasText: /^forma de pagamento$/u }),
  ).toBeVisible();
  await expect(summary).toContainText('CAMISETA · GOLA OLÍMPICA');
  await expect(summary).toContainText('150 peças');
  await expect(summary).toContainText('A definir');
  await expect(
    summary.getByRole('link', { name: 'Abrir pedido' }),
  ).toHaveAttribute('href', '/pedidos/order-pendente?conversa=conversation-1');
  // The summary reads the order; it never edits it.
  await expect(summary.locator('input, textarea, select')).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Esc closes it and the button that opened it takes focus back.
  await page.keyboard.press('Escape');
  await expect(context).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('PCX-12: on a phone the details icon opens Pedido and Esc hands focus back', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCrm(page, { order: conversationOrder });
  await page.goto('/inbox/conversation-1');

  // The order link keeps a 44 px target in the header.
  const link = page
    .locator('.conv-head')
    .getByRole('link', { name: 'Abrir pedido 07-CRM, pendente' });
  expect((await link.boundingBox())?.height).toBeGreaterThanOrEqual(44);

  const details = page.getByRole('button', { name: 'Detalhes do atendimento' });
  await details.focus();
  await page.keyboard.press('Enter');
  const context = page.getByRole('dialog', { name: 'Atendimento' });
  await expect(context).toBeVisible();
  await expect(
    context.getByRole('button', { name: 'Recolher detalhes' }),
  ).toBeFocused();
  const orderSummary = context.getByRole('region', {
    name: 'Pedido',
    exact: true,
  });
  await orderSummary
    .locator('summary', { hasText: 'Pendências do pedido' })
    .click();
  await expect(orderSummary).toContainText('valor final');
  await expect(orderSummary).toContainText('forma de pagamento');

  // The close button keeps a 44 px target, 8 px or more from the edge.
  const close = context.getByRole('button', { name: 'Recolher detalhes' });
  const box = await close.boundingBox();
  if (!box) throw new Error('The close button must be visible');
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(390 - (box.x + box.width)).toBeGreaterThanOrEqual(8);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(context).toBeHidden();
  await expect(details).toBeFocused();
});

test('PCX-10: reaches the order page from the header with the keyboard alone', async ({
  page,
}) => {
  await mockCrm(page, { order: conversationOrder });
  await page.goto('/inbox/conversation-1');

  // The order link follows the name's new contact-data button.
  await page.getByRole('button', { name: 'Dados de Studio Malu' }).focus();
  await page.keyboard.press('Tab');
  const link = page
    .locator('.conv-head')
    .getByRole('link', { name: 'Abrir pedido 07-CRM, pendente' });
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(
    '/pedidos/order-pendente?conversa=conversation-1',
  );
});

test('PCX-11: offers "Criar pedido" in the header only to the owner and creates it there', async ({
  page,
}) => {
  const heading = page.getByRole('heading', { level: 2, name: 'Studio Malu' });
  // PCL-11: a conversation that already has a pending order never offers it.
  await mockCrm(page, { order: conversationOrder });
  await page.goto('/inbox');
  await expect(
    page.getByRole('link', { name: 'Abrir pedido 07-CRM, pendente' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar pedido' })).toHaveCount(
    0,
  );

  // PCL-10: a seller who neither owns the conversation nor administrates it
  // is never offered the action the API would refuse with 403.
  await mockCrm(page, { noAdmin: true, order: null, otherOwner: true });
  await page.reload();
  await expect(heading).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar pedido' })).toHaveCount(
    0,
  );

  // An administrator may create it while the agent still answers: from
  // "Mais", never beside the primary action, which sits in the composer
  // (PCX-13).
  await mockCrm(page, { assistant: true, order: null });
  await page.reload();
  await expect(heading).toBeVisible();
  const actions = page.locator('.conv-actions');
  await expect(
    page
      .locator('.conv-actions')
      .getByRole('button', { name: 'Assumir atendimento' }),
  ).toBeVisible();
  await expect(
    actions.locator(':scope > button', { hasText: 'Criar pedido' }),
  ).toHaveCount(0);
  await actions.getByRole('button', { name: 'Mais ações' }).click();
  await expect(
    page
      .locator('#conv-more-menu')
      .getByRole('button', { name: 'Criar pedido' }),
  ).toBeVisible();

  // PCX-11: the seller who has the conversation creates it from the header,
  // pre-filled from the conversation; the link takes the button's place and
  // the focus.
  let createdBody;
  await mockCrm(page, {
    noAdmin: true,
    onCreateOrder: (body) => (createdBody = body),
    order: null,
  });
  await page.reload();
  await page.evaluate(() => {
    globalThis.document.cookie = 'crm_csrf=csrf-test; Path=/; SameSite=Lax';
  });
  const create = actions.getByRole('button', { name: 'Criar pedido' });
  await create.click();
  const link = page
    .locator('.conv-head')
    .getByRole('link', { name: 'Abrir pedido 11-CRM, pendente' });
  await expect(link).toBeFocused();
  await expect(link).toHaveAttribute(
    'href',
    '/pedidos/order-novo?conversa=conversation-1',
  );
  await expect(page.locator('.notice-toast')).toContainText(
    'Pedido 11-CRM criado.',
  );
  await expect(create).toHaveCount(0);
  expect(createdBody).toEqual({ expectedVersion: 3 });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('drops the pending AI suggestion block from the conversation', async ({
  page,
}) => {
  await mockCrm(page, { suggestion: true });
  await page.goto('/inbox');

  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/ }),
  ).toBeVisible();
  // PCX-01/D21: the block is gone even when the read model still answers one.
  await expect(page.getByText('Sugestão pendente da IA')).toHaveCount(0);
  await expect(page.locator('.suggestion')).toHaveCount(0);
});

test('does not expose the technical contact identifier in the client list', async ({
  page,
}) => {
  await mockCrm(page);

  await page.goto('/clientes');

  await expect(page.getByRole('link', { name: 'Studio Malu' })).toBeVisible();
  await expect(page.getByText(contact.id, { exact: true })).toHaveCount(0);
});

test('checks a new customer phone privately and requires choosing an existing candidate', async ({
  page,
}) => {
  await mockCrm(page);
  /** @type {any[]} */
  const searched = [];
  let createdContacts = 0;
  await page.route('**/api/v1/contacts/search', async (route) => {
    const request = route.request();
    searched.push(request.postDataJSON());
    expect(request.method()).toBe('POST');
    expect(request.url()).not.toContain('98765');
    expect(request.headers()['x-csrf-token']).toBe('csrf-test');
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            ...contact,
            id: 'site-contact',
            identities: [
              {
                channel: 'site_chat',
                externalId: '999123456789012',
                id: 'site-identity',
                kind: 'handle',
                phoneStatus: 'pending',
              },
            ],
            label: 'Ana do site',
            phone: '5511987654321',
            phoneSource: 'site_unverified',
          },
          {
            ...contact,
            id: 'whatsapp-contact',
            label: 'Ana WhatsApp',
            phone: '5511987654321',
            phoneSource: 'whatsapp',
          },
        ],
        nextCursor: null,
        totalCount: 2,
      }),
    });
  });
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname === '/api/v1/contacts' &&
      request.method() === 'POST'
    ) {
      createdContacts += 1;
    }
  });
  await page.goto('/pedidos');
  await page.evaluate(() => {
    globalThis.document.cookie = 'crm_csrf=csrf-test; Path=/; SameSite=Lax';
  });
  await page.getByRole('button', { name: 'Novo pedido' }).click();
  const dialog = page.getByRole('dialog', { name: 'Novo pedido' });
  await dialog.getByLabel('Nome', { exact: true }).fill('Ana Nova');
  await dialog
    .getByLabel('Telefone', { exact: true })
    .last()
    .fill('(11) 98765-4321');
  await expect(
    dialog.getByText('Esse telefone já aparece no CRM.'),
  ).toBeVisible();
  await expect(
    dialog.getByText('informado no site · não confirmado'),
  ).toBeVisible();
  await expect(dialog.getByText('999123456789012')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Criar pedido' }).click();
  await expect(
    dialog
      .getByRole('alert')
      .filter({ hasText: 'Escolha um cliente da lista' }),
  ).toBeVisible();
  expect(createdContacts).toBe(0);
  expect(searched.some((search) => search.q === '(11) 98765-4321')).toBe(true);
  await dialog.getByRole('button', { name: /Selecionar Ana do site/ }).click();
  await expect(dialog.getByText('Cliente selecionado:')).toBeVisible();
  const unverifiedPhone = dialog
    .getByRole('status')
    .filter({ hasText: 'Este telefone foi informado no chat' });
  await expect(unverifiedPhone).toBeFocused();
  await expect(
    dialog.getByRole('button', { name: 'Criar pedido' }),
  ).toBeDisabled();
  await expect(
    unverifiedPhone.getByRole('link', { name: 'ficha do contato' }),
  ).toHaveAttribute('href', '/clientes/site-contact');

  await dialog.getByRole('button', { name: 'Trocar cliente' }).click();
  await dialog.getByLabel('Buscar cliente por telefone ou nome').fill('Ana');
  await dialog.getByRole('button', { name: /Selecionar Ana WhatsApp/ }).click();
  await expect(
    dialog.getByRole('button', { name: 'Criar pedido' }),
  ).toBeEnabled();
});

test('opens a client by clicking the whole row while keeping its keyboard link', async ({
  page,
}) => {
  await mockCrm(page);
  await page.goto('/clientes');
  await page
    .getByRole('row', { name: /Studio Malu/ })
    .getByRole('cell', { name: /Canônico/ })
    .click();
  await expect(page).toHaveURL('/clientes/contact-1');
  await page.getByRole('link', { name: 'Studio Malu' }).focus();
  await expect(page.getByRole('link', { name: 'Studio Malu' })).toBeFocused();
});

test('keeps a long client list inside its own scrollable table', async ({
  page,
}) => {
  await mockCrm(page, { manyContacts: true });
  await page.goto('/clientes/contact-1');
  const table = page.getByRole('region', {
    name: /Clientes; role horizontalmente/u,
  });
  await expect(table.getByRole('row')).toHaveCount(61);
  await expect(
    page.getByRole('heading', { name: 'Studio Malu' }),
  ).toBeVisible();
  const tableMetrics = () =>
    table.evaluate((element) => {
      const root = globalThis.document.documentElement;
      // Scrolled to the bottom of the page, where the top bar overlaps most.
      globalThis.scrollTo(0, root.scrollHeight);
      const panel = element.closest('.list-panel');
      return {
        clientHeight: element.clientHeight,
        headingTop: element.querySelector('th')?.getBoundingClientRect().top,
        pageHeight: root.scrollHeight,
        panelBottom: panel?.getBoundingClientRect().bottom,
        panelTop: panel?.getBoundingClientRect().top,
        scrollHeight: element.scrollHeight,
        tableTop: element.getBoundingClientRect().top,
        topbarBottom: globalThis.document
          .querySelector('.app-topbar')
          ?.getBoundingClientRect().bottom,
        viewportHeight: globalThis.innerHeight,
      };
    });

  for (const viewport of [
    { height: 720, width: 1280 },
    { height: 844, width: 390 },
  ]) {
    await page.setViewportSize(viewport);
    const metrics = await tableMetrics();
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.clientHeight).toBeLessThan(metrics.viewportHeight);
    // The page no longer grows with the list it holds.
    expect(metrics.pageHeight).toBeLessThan(metrics.scrollHeight);
    if (viewport.width >= 1200) {
      // Beside the contact card, the list stays whole below the top bar.
      expect(metrics.panelTop).toBeGreaterThanOrEqual(
        Number(metrics.topbarBottom),
      );
      expect(metrics.panelBottom).toBeLessThanOrEqual(metrics.viewportHeight);
    }
  }

  // The column headings stay on top while the rows scroll under them.
  await table.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const pinned = await tableMetrics();
  expect(Math.abs(Number(pinned.headingTop) - pinned.tableTop)).toBeLessThan(2);

  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await table.evaluate((element) => {
    element.scrollTop = 0;
  });
  const lastClient = page.getByRole('link', { name: 'Cliente de teste 60' });
  await lastClient.focus();
  await expect(lastClient).toBeInViewport();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('recovers the client list after an initial server failure without showing an empty list', async ({
  page,
}) => {
  await mockCrm(page);
  let reads = 0;
  await page.route(/\/api\/v1\/contacts\?/u, async (route) => {
    reads += 1;
    if (reads > 1) return route.fallback();
    return route.fulfill({
      body: JSON.stringify({ code: 'UNAVAILABLE' }),
      contentType: 'application/problem+json',
      status: 503,
    });
  });
  await page.goto('/clientes');

  await expect(
    page.getByRole('heading', { name: 'Clientes indisponíveis' }),
  ).toBeVisible();
  await expect(page.getByText('Nenhum contato encontrado')).toHaveCount(0);
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('link', { name: 'Studio Malu' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Clientes', exact: true }),
  ).toBeFocused();
});

test('keeps loaded clients visible when a live refresh fails', async ({
  page,
}) => {
  await mockCrm(page);
  let reads = 0;
  await page.route(/\/api\/v1\/contacts\?/u, async (route) => {
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
        contactId: 'contact-1',
        type: 'inbox.contact.changed',
      }),
      contentType: 'text/event-stream',
      status: 200,
    });
  });
  await page.goto('/clientes');
  await expect(page.getByRole('link', { name: 'Studio Malu' })).toBeVisible();

  sendEvent();
  await expect(page.getByRole('alert')).toContainText(
    'Os dados exibidos podem estar desatualizados.',
  );
  await expect(page.getByRole('link', { name: 'Studio Malu' })).toBeVisible();
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(reads).toBe(3);
});

test('lets a keyboard user scroll the client table on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCrm(page);
  await page.goto('/clientes');

  const tableRegion = page.getByRole('region', {
    name: /Clientes; role horizontalmente/u,
  });
  await expect(tableRegion).toBeVisible();
  await expect(
    page.getByText('Deslize a tabela para ver todas as colunas.'),
  ).toBeVisible();
  expect(
    await tableRegion.evaluate((element) => element.scrollWidth),
  ).toBeGreaterThan(
    await tableRegion.evaluate((element) => element.clientWidth),
  );
  await tableRegion.focus();
  await expect(tableRegion).toBeFocused();
  await tableRegion.press('ArrowRight');
  await expect
    .poll(() => tableRegion.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
});

test('simplifies the client summary without operational status or count', async ({
  page,
}) => {
  await mockCrm(page);

  await page.goto('/clientes');

  await expect(page.getByRole('button', { name: 'Editar nome' })).toBeVisible();
  await expect(page.getByText('Cadastro provisório')).toHaveCount(0);
  await expect(
    page.locator('.client-facts').getByText('Conversas'),
  ).toHaveCount(0);
});

test('formats the contact phone without an editable input', async ({
  page,
}) => {
  await mockCrm(page);

  await page.goto('/clientes');

  await expect(page.locator('.contact-phone dd')).toHaveText(
    '+55 (11) 99999-9999',
  );
  await expect(page.locator('.contact-phone input')).toHaveCount(0);
  await expect(page.getByText('Telefone: confirmed')).toHaveCount(0);
  await expect(
    page.locator('.contact-channels').getByText('WhatsApp', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page
      .locator('.contact-channels')
      .getByText(contact.identities[0].externalId, { exact: true }),
  ).toHaveCount(0);
});

test('opens a conversation by its address and keeps the Inbox while moving between them', async ({
  page,
}) => {
  await mockCrm(page, { waitingQueue: true });
  await page.goto('/inbox/conversation-3');

  await expect(
    page.getByRole('heading', { name: 'Caixa de Entrada', level: 1 }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Igreja Nova Aliança' }),
  ).toBeVisible();
  await expect(
    page
      .locator('.inbox-list')
      .getByRole('button', { name: /Igreja Nova Aliança/u }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(
    page
      .getByRole('navigation', { name: 'Navegação principal' })
      .getByRole('link', { name: 'Caixa de Entrada' }),
  ).toHaveAttribute('aria-current', 'page');

  // The opened conversation stays while the search narrows the list.
  const search = page.locator('#inbox-search');
  await search.fill('Studio');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Igreja Nova Aliança' }),
  ).toBeVisible();

  // Picking another one changes the address, not the Inbox around it.
  const studio = page
    .locator('.inbox-list')
    .getByRole('button', { name: /Studio Malu/u });
  await studio.click();
  await expect(page).toHaveURL('/inbox/conversation-1');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Studio Malu' }),
  ).toBeVisible();
  await expect(search).toHaveValue('Studio');
  await expect(studio).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL('/inbox/conversation-3');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Igreja Nova Aliança' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('opens the conversation straight from its address and from Clientes', async ({
  page,
}) => {
  // The Dashboard (Painel) lists indicators, each opening the Inbox already
  // filtered; the conversation itself is reached by its address.
  await mockCrm(page);
  await page.goto('/inbox/conversation-1');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Studio Malu' }),
  ).toBeVisible();

  await page.goto('/clientes/contact-1');
  await expect(
    page.locator('.history-list').getByRole('link', { name: 'WhatsApp' }),
  ).toHaveAttribute('href', '/inbox/conversation-1');
});

test('on a phone the address decides between the list and the conversation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCrm(page, { waitingQueue: true });
  await page.goto('/inbox');

  await expect(page.locator('.inbox-list')).toBeVisible();
  await expect(page.locator('.inbox-conversation')).toBeHidden();
  await page
    .locator('.inbox-list')
    .getByRole('button', { name: /Studio Malu/u })
    .click();
  await expect(page).toHaveURL('/inbox/conversation-1');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Studio Malu' }),
  ).toBeFocused();
  await expect(page.locator('.inbox-list')).toBeHidden();
  // PCX-15: takeover remains the only primary action, now in the header.
  const reasonRegion = page.locator('.handoff-reason');
  const takeOver = page.locator('.conv-actions').getByRole('button', {
    name: 'Assumir atendimento',
  });
  await expect(takeOver).toBeInViewport({ ratio: 1 });
  await expect(reasonRegion).toContainText('Perguntou o valor');
  await expect(reasonRegion).toContainText(
    /Esperando vendedor há 2h \d\dmin\./u,
  );
  await expect(page.getByLabel('Responder')).toHaveCount(0);
  await expect(page.locator('.inbox-conversation .primary')).toHaveCount(1);
  expect((await takeOver.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // PCX-15: before claim there is no reply; takeover stays above navigation.
  await expect(page.locator('.inbox-composer')).toHaveCount(0);
  const takeoverBox = await takeOver.boundingBox();
  const bar = await page.locator('.mobile-nav').boundingBox();
  if (!takeoverBox || !bar) throw new Error('Takeover and bar must be visible');
  expect(takeoverBox.y + takeoverBox.height).toBeLessThanOrEqual(bar.y + 1);

  // Secondary actions live in the "Mais" bottom sheet, with 44 px targets.
  const more = page.getByRole('button', { name: 'Mais ações' });
  expect((await more.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await more.click();
  const sheet = page.locator('#conv-more-menu');
  // PCX-11: waiting for a seller, an administrator creates the order from
  // here; "Encerrar conversa" closes the list (PCX-13).
  await expect(sheet.getByRole('button')).toHaveText([
    'Criar pedido',
    'Arquivar conversa',
    'Encerrar conversa',
  ]);
  await expect(
    sheet.getByRole('button', { name: 'Criar pedido' }),
  ).toBeFocused();
  for (const box of await sheet
    .getByRole('button')
    .evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().height),
    )) {
    expect(box).toBeGreaterThanOrEqual(44);
  }
  const sheetBox = await sheet.boundingBox();
  if (!sheetBox) throw new Error('The sheet must be visible');
  expect(sheetBox.y + sheetBox.height).toBeLessThanOrEqual(bar.y + 1);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();

  await page.getByRole('link', { name: 'Conversas', exact: true }).click();
  await expect(page).toHaveURL('/inbox');
  await expect(
    page.locator('.inbox-list').getByRole('button', { name: /Studio Malu/u }),
  ).toBeFocused();
});

test('on a phone the reply goes right above the keyboard while typing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockCrm(page);
  await page.goto('/inbox/conversation-1');
  const bar = page.locator('.mobile-nav');
  await expect(bar).toBeVisible();
  await page.getByLabel('Responder').focus();
  // The navigation bar steps aside; the composer takes the bottom edge.
  await expect(bar).toBeHidden();
  const composer = await page.locator('.inbox-composer').boundingBox();
  if (!composer) throw new Error('The composer must be visible');
  expect(composer.y + composer.height).toBeGreaterThan(844 - 8);
  await page.getByLabel('Responder').blur();
  await expect(bar).toBeVisible();
});

test('sends the reply with Enter and breaks the line with Shift+Enter', async ({
  page,
}) => {
  /** @type {any[]} */
  const sent = [];
  await mockCrm(page, { onMessage: (body) => sent.push(body) });
  await page.goto('/inbox/conversation-1');
  await page.evaluate(() => {
    globalThis.document.cookie = 'crm_csrf=csrf-test; Path=/; SameSite=Lax';
  });
  await expect(page.locator('#reply-help')).toHaveText(
    'Enter envia · Shift+Enter quebra a linha.',
  );

  const reply = page.getByLabel('Responder');
  await reply.click();
  await page.keyboard.press('Enter');
  expect(sent).toEqual([]);
  await reply.pressSequentially('Primeira linha');
  await page.keyboard.press('Shift+Enter');
  await reply.pressSequentially('Segunda linha');
  await expect(reply).toHaveValue('Primeira linha\nSegunda linha');
  expect(sent).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(page.getByText('Mensagem aceita para envio.')).toBeVisible();
  expect(sent).toEqual([
    {
      content: { text: 'Primeira linha\nSegunda linha' },
      expectedVersion: 3,
      messageType: 'text',
      reason: 'Resposta humana na Caixa de Entrada',
    },
  ]);
  await expect(reply).toHaveValue('');
  await expect(reply).toBeFocused();
});

test('keeps the reply in view and opens the history on the latest message at 1366×768', async ({
  page,
}) => {
  await mockCrm(page, { longThread: true });
  // 768 is the screen; 657 is what a browser with its bars leaves of it.
  for (const height of [768, 657]) {
    await page.setViewportSize({ width: 1366, height });
    await page.goto('/inbox/conversation-1');
    const thread = page.locator('.thread');
    await expect(thread.getByText('Mensagem de teste 30:')).toBeInViewport();
    await expect(thread.getByText('Mensagem de teste 1:')).not.toBeInViewport();
    await expect(page.getByLabel('Responder')).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole('button', { name: 'Enviar resposta' }),
    ).toBeInViewport({ ratio: 1 });
    // On a 1366 notebook the conversation comes first: context on demand.
    await expect(
      page.getByRole('dialog', { name: 'Atendimento' }),
    ).toBeHidden();
    // The workspace fits the screen: the page itself never scrolls.
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollHeight <=
          globalThis.innerHeight,
      ),
    ).toBe(true);
  }
});

test('opens the context overlay on demand at wide widths and starts closed after reload', async ({
  page,
}) => {
  await mockCrm(page);
  // INBOX-UX-03: even a wide screen keeps secondary data behind the overlay.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/inbox/conversation-1');
  const context = page.getByRole('dialog', { name: 'Atendimento' });
  const toggle = page
    .locator('.conv-actions')
    .getByRole('button', { name: 'Detalhes do atendimento' });
  await expect(context).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(context).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await context.getByRole('button', { name: 'Recolher detalhes' }).click();
  await expect(context).toBeHidden();
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  await page.reload();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Studio Malu' }),
  ).toBeVisible();
  await expect(context).toBeHidden();
  await toggle.click();
  await expect(context).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('INBOX-UX-01: compact navigation preserves focus, destinations and the saved choice', async ({
  page,
}, testInfo) => {
  await mockCrm(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/inbox/conversation-1');
  const shell = page.locator('.app-shell');
  const menu = page.locator('.sidebar-toggle');
  const navigation = page.getByRole('navigation', {
    name: 'Navegação principal',
  });
  await expect(shell).toHaveAttribute('data-sidebar', 'compact');
  await expect(menu).toHaveAccessibleName('Expandir menu');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  expect(
    await page.evaluate(() =>
      globalThis.localStorage.getItem('crm.sidebar.compact'),
    ),
  ).toBeNull();
  const compactChat = await page.locator('.inbox-conversation').boundingBox();
  await page.screenshot({ path: testInfo.outputPath('inbox-compact.png') });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toBeFocused();
  await expect(menu).toHaveAccessibleName('Recolher menu');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  const expandedChat = await page.locator('.inbox-conversation').boundingBox();
  if (!compactChat || !expandedChat)
    throw new Error('Conversation must be visible');
  expect(compactChat.width - expandedChat.width).toBeGreaterThan(100);
  await expect(
    navigation.getByRole('link', { name: 'Caixa de Entrada' }),
  ).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(shell).toHaveAttribute('data-sidebar', 'expanded');
  await menu.press('Enter');
  await expect(menu).toBeFocused();
  await navigation.getByRole('link', { name: 'Pedidos', exact: true }).focus();
  await expect(
    page.locator('.app-sidebar a:focus .sidebar-tooltip'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    navigation.getByRole('link', { name: 'Pedidos', exact: true }),
  ).toBeFocused();
  await expect(
    page.locator('.app-sidebar a:focus .sidebar-tooltip'),
  ).toBeHidden();
  const reply = page.getByLabel('Responder', { exact: true });
  await reply.focus();
  const ordersLink = navigation.getByRole('link', {
    name: 'Pedidos',
    exact: true,
  });
  await ordersLink.hover();
  await expect(ordersLink.locator('.sidebar-tooltip')).toBeVisible();
  await ordersLink.locator('.sidebar-tooltip').hover();
  await expect(ordersLink.locator('.sidebar-tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(ordersLink.locator('.sidebar-tooltip')).toBeHidden();
  await expect(reply).toBeFocused();
  await navigation.getByRole('link', { name: 'Pedidos', exact: true }).click();
  await expect(shell).toHaveAttribute('data-sidebar', 'compact');
  await page.reload();
  await expect(shell).toHaveAttribute('data-sidebar', 'compact');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(menu).toBeHidden();
  await expect(page.locator('.mobile-nav')).toBeVisible();
  await page.setViewportSize({ width: 1366, height: 768 });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const storage of ['invalid', 'blocked']) {
  test(`INBOX-UX-01: menu and details work with ${storage} browser storage`, async ({
    page,
  }) => {
    await mockCrm(page);
    await page.addInitScript((mode) => {
      if (mode === 'blocked') {
        Object.defineProperty(globalThis, 'localStorage', {
          get() {
            throw new globalThis.DOMException(
              'Storage unavailable',
              'SecurityError',
            );
          },
        });
      } else {
        globalThis.localStorage.setItem('crm.sidebar.compact', 'invalid');
      }
    }, storage);
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto('/inbox/conversation-1');
    const menu = page.locator('.sidebar-toggle');
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    const details = page.getByRole('button', {
      name: 'Detalhes do atendimento',
      exact: true,
    });
    await expect(details).toHaveAccessibleName('Detalhes do atendimento');
    await details.press('Enter');
    await expect(
      page
        .getByRole('dialog', { name: 'Atendimento' })
        .getByRole('button', { name: 'Recolher detalhes' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(details).toBeFocused();
    await expect(details).toHaveAttribute('aria-expanded', 'false');
  });
}

test('formats the phone in contact data without expanding the conversation header', async ({
  page,
}) => {
  await mockCrm(page, { assistant: true });

  await page.goto('/inbox');

  await expect(page.locator('.conv-identity')).toContainText('Com o agente');
  await expect(page.locator('.conv-identity')).not.toContainText('+55');
  await page.getByRole('button', { name: 'Dados de Studio Malu' }).click();
  await expect(page.getByRole('dialog', { name: 'Cadastro' })).toContainText(
    '+55 (11) 99999-9999',
  );
});

test('sends an authorized human reply through the official command', async ({
  page,
}) => {
  let sentBody;
  await mockCrm(page, { onMessage: (body) => (sentBody = body) });
  await page.goto('/inbox');
  await page.evaluate(() => {
    globalThis.document.cookie = 'crm_csrf=csrf-test; Path=/; SameSite=Lax';
  });
  await page.getByLabel('Responder').fill('Resposta persistida');
  await page.getByRole('button', { name: 'Enviar resposta' }).click();
  await expect(page.getByText('Mensagem aceita para envio.')).toBeVisible();
  expect(sentBody).toEqual({
    content: { text: 'Resposta persistida' },
    expectedVersion: 3,
    messageType: 'text',
    reason: 'Resposta humana na Caixa de Entrada',
  });
});

test.skip('keeps the official command authoritative and refetches after 409', async ({
  page,
}) => {
  await mockCrm(page, { conflict: true });
  await page.goto('/kanban');
  const move = page.getByRole('button', { name: /Mover Cliente 028/ });
  await move.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Cliente 028' });
  await dialog.getByLabel('Etapa adjacente').selectOption('specification');
  await dialog.getByLabel('Motivo').fill('Dados confirmados');
  await dialog
    .getByRole('button', { name: 'Confirmar mudança' })
    .press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'mudou enquanto você trabalhava',
  );
  await expect(page.getByText('Cliente 028')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Mover Cliente 028/ }),
  ).toBeFocused();
});

test.skip('uses one SSE per session and refetches without stealing focus', async ({
  page,
}) => {
  let boardRequests = 0;
  await page.addInitScript(() => {
    const testGlobal = /** @type {any} */ (globalThis);
    testGlobal.__kanbanSources = [];
    class FakeEventSource extends globalThis.EventTarget {
      constructor() {
        super();
        testGlobal.__kanbanSources.push(this);
      }
      close() {}
    }
    testGlobal.EventSource = FakeEventSource;
  });
  await mockCrm(page, { onBoard: () => (boardRequests += 1) });
  await page.goto('/kanban');
  const move = page.getByRole('button', { name: /Mover Cliente 028/ });
  await move.focus();
  await page.evaluate(() => {
    const testGlobal = /** @type {any} */ (globalThis);
    const event = new globalThis.MessageEvent('kanban.card.changed', {
      data: JSON.stringify({ dealId: 'deal-1', dealVersion: 5 }),
    });
    Object.defineProperty(event, 'lastEventId', { value: 'evt-9' });
    testGlobal.__kanbanSources[0].dispatchEvent(event);
  });
  await expect.poll(() => boardRequests).toBeGreaterThan(1);
  await expect(move).toBeFocused();
  expect(
    await page.evaluate(
      () => /** @type {any} */ (globalThis).__kanbanSources.length,
    ),
  ).toBe(1);
});

test.skip('supports empty and error states without accessibility violations', async ({
  page,
}) => {
  await mockCrm(page, { empty: true });
  await page.goto('/kanban');
  await expect(page.getByText('Nenhum negócio nesta etapa.')).toHaveCount(5);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test.skip('reflows at 320px, 200% zoom and reduced motion', async ({
  page,
}) => {
  await mockCrm(page);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/kanban');
  await page.evaluate(() => {
    globalThis.document.documentElement.style.zoom = '2';
  });
  await expect(page.getByLabel('Etapa visível')).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      globalThis.document.documentElement.scrollWidth >
      globalThis.document.documentElement.clientWidth,
  );
  expect(overflow).toBe(false);
});

test.skip('renders a recoverable board error', async ({ page }) => {
  await mockCrm(page, { failBoard: true });
  await page.goto('/kanban');
  await expect(
    page.getByRole('main').getByText('Não foi possível carregar o Kanban.'),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Tentar novamente' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test.skip('restores focus after retrying a failed deal detail', async ({
  page,
}) => {
  await mockCrm(page, { failDetailOnce: true });
  await page.goto('/negocios/deal-1');
  const retry = page.getByRole('button', { name: 'Tentar novamente' });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(
    page.getByRole('heading', { name: 'Cliente 028' }),
  ).toBeFocused();
});
