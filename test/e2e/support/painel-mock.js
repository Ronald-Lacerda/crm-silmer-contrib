// Mock da API do Painel (Dashboard por papel) com dados sintéticos. Uso:
// `const mock = await mockPainel(page, { manager: false })` antes de
// `page.goto(...)`; `mock.periods`, `mock.orderLists` e `mock.inboxLists`
// registram o que a tela pediu. `QUEUE` e `ordersSummary(key)` são as
// respostas da fila e do resumo de pedidos por período; `queue` em
// `mockPainel` troca a resposta da fila (PNL-06).

/** Dashboard reads for fixtures whose primary subject is another screen.
 * @param {import('@playwright/test').Route} route
 * @param {boolean} [manager]
 */
export async function mockDashboardRead(route, manager = true) {
  const url = new URL(route.request().url());
  let body;
  if (url.pathname === '/api/v1/dashboard/actions')
    body = {
      generatedAt: '2026-10-15T15:00:00Z',
      today: '2026-10-15',
      items: [],
      hasMore: false,
    };
  if (url.pathname === '/api/v1/dashboard/performance')
    body = performanceSummary(
      manager,
      Number(url.searchParams.get('days') ?? 7),
    );
  if (url.pathname === '/api/v1/dashboard/metrics/service')
    body = serviceMetrics(manager, Number(url.searchParams.get('days') ?? 7));
  if (url.pathname === '/api/v1/dashboard/metrics/losses')
    body = lossMetrics(manager, Number(url.searchParams.get('days') ?? 7));
  if (!body) return false;
  await route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  return true;
}

export const QUEUE = Object.freeze({
  assistant: {
    activeCount: 4,
    failedDeliveryCount: 1,
    lastReplyAt: '2026-10-15T14:58:00.000Z',
    stallMinutes: 10,
    stalledCount: 1,
  },
  generatedAt: '2026-10-15T15:00:00.000Z',
  mine: {
    awaitingReplyCount: 2,
    count: 3,
    oldestAwaitingSince: '2026-10-15T14:35:00.000Z',
    pendingOrderCount: 2,
  },
  // PNL-06: only a COMMERCIAL_ADMIN reading gets the breakdown.
  unanswered: {
    bySeller: [
      { count: 3, name: 'Vendedor Sintético', userId: 'seller-2' },
      { count: 1, name: 'Atendente Sintética', userId: 'seller-1' },
    ],
    count: 4,
    thresholdMinutes: 15,
  },
  waitingHandoff: {
    count: 3,
    oldestSince: '2026-10-15T09:00:00.000Z',
    overdueCount: 1,
  },
});

/** PNL-05: the last seven São Paulo days, oldest first, today last. */
export const DAILY = Object.freeze([
  { confirmedCount: 10, day: '2026-10-09', soldAmountCents: 412_000 },
  { confirmedCount: 6, day: '2026-10-10', soldAmountCents: 200_000 },
  { confirmedCount: 2, day: '2026-10-11', soldAmountCents: 85_000 },
  { confirmedCount: 14, day: '2026-10-12', soldAmountCents: 570_000 },
  { confirmedCount: 18, day: '2026-10-13', soldAmountCents: 650_000 },
  { confirmedCount: 16, day: '2026-10-14', soldAmountCents: 720_000 },
  { confirmedCount: 1, day: '2026-10-15', soldAmountCents: 180_000 },
]);

/** @returns {Record<string, any>[]} */
export function actionItems() {
  const base = {
    targetVersion: 4,
    sourceRevision: 'revision-4',
    decisionVersion: 0,
    deferred: false,
    dueAt: null,
    remindAt: null,
  };
  return [
    {
      ...base,
      id: 'conversation:reply-1',
      targetType: 'conversation',
      targetId: 'reply-1',
      conversationId: 'reply-1',
      kind: 'reply',
      title: 'Cliente Sintético',
      subtitle: 'Espera sua resposta sobre tecido',
      attentionSince: '2026-10-15T14:35:00Z',
    },
    {
      ...base,
      id: 'order:manual-12',
      targetType: 'order',
      targetId: 'manual-12',
      kind: 'order_followup',
      title: 'Equipe Sintética',
      subtitle: '12-CRM · conferir pagamento e entrega',
      attentionSince: '2026-10-13T12:00:00Z',
      order: {
        id: 'manual-12',
        number: '12-CRM',
        status: 'confirmado',
        finalAmountCents: 128000,
        totalPieces: 20,
        paidOn: null,
        deliveredOn: null,
        paymentReviewRequired: false,
        promisedDeliveryOn: '2026-10-15',
        version: 4,
      },
    },
    {
      ...base,
      id: 'order:manual-13',
      targetType: 'order',
      targetId: 'manual-13',
      kind: 'order_followup',
      title: 'Turma Sintética',
      subtitle: '13-CRM · conferir entrega',
      attentionSince: '2026-10-12T12:00:00Z',
      order: {
        id: 'manual-13',
        number: '13-CRM',
        status: 'confirmado',
        finalAmountCents: 96000,
        totalPieces: 16,
        paidOn: '2026-10-13',
        deliveredOn: null,
        paymentReviewRequired: false,
        promisedDeliveryOn: '2026-10-14',
        version: 4,
      },
    },
    {
      ...base,
      id: 'conversation:follow-1',
      targetType: 'conversation',
      targetId: 'follow-1',
      conversationId: 'follow-1',
      kind: 'followup',
      title: 'Contato Sintético',
      subtitle: 'Última mensagem sem resposta',
      attentionSince: '2026-10-13T14:00:00Z',
    },
    {
      ...base,
      id: 'handoff:handoff-1',
      targetType: 'conversation',
      targetId: 'waiting-1',
      conversationId: 'waiting-1',
      kind: 'handoff',
      title: 'Conversa Sintética',
      subtitle: 'Aguarda uma pessoa',
      attentionSince: '2026-10-15T13:00:00Z',
      handoff: { id: 'handoff-1', version: 1 },
    },
  ];
}

/** @param {boolean} manager @param {number} days */
export function performanceSummary(manager, days = 7) {
  const rows = [
    {
      userId: 'seller-1',
      name: 'Atendente Sintética',
      active: true,
      soldAmountCents: 840000,
      confirmedCount: 6,
      averageTicketCents: 140000,
      attendedCount: 14,
      assumedCount: 9,
      closedCount: 8,
      conversationsWithSaleCount: 4,
    },
  ];
  if (manager)
    rows.push({
      userId: 'seller-2',
      name: 'Vendedor Sintético',
      active: false,
      soldAmountCents: 620000,
      confirmedCount: 5,
      averageTicketCents: 124000,
      attendedCount: 12,
      assumedCount: 8,
      closedCount: 6,
      conversationsWithSaleCount: 3,
    });
  return {
    generatedAt: QUEUE.generatedAt,
    from: '2026-10-09',
    to: '2026-10-15',
    days,
    rows,
    store: {
      soldAmountCents: manager ? 180000 : 0,
      confirmedCount: manager ? 2 : 0,
    },
    unattributed: { soldAmountCents: 0, confirmedCount: 0 },
    totals: {
      soldAmountCents: manager ? 1640000 : 840000,
      confirmedCount: manager ? 13 : 6,
    },
  };
}

const BUSINESS_HOURS = Object.freeze({
  policy: 'expediente-v1',
  weekdays: [1, 2, 3, 4, 5],
  blocks: [
    ['09:00', '12:00'],
    ['13:00', '18:00'],
  ],
  unansweredThresholdMinutes: 15,
});

/** MET-02..05 (RFC 048): synthetic service times in business minutes.
 * @param {boolean} manager @param {number} days */
export function serviceMetrics(manager, days = 7) {
  /** @type {Array<Record<string, any>>} */
  const rows = [
    {
      userId: 'seller-1',
      name: 'Atendente Sintética',
      active: true,
      firstResponse: {
        samples: 9,
        medianMinutes: 4.5,
        p90Minutes: 12,
        openCount: 0,
        oldestOpenMinutes: null,
        closedWithoutReply: 0,
      },
      claim: { samples: 7, medianMinutes: 6, p90Minutes: 15.5 },
      unansweredNow: { count: 0, oldestWaitingMinutes: null },
      unansweredEpisodes: { count: 1 },
    },
  ];
  if (manager)
    rows.push({
      userId: 'seller-2',
      name: 'Vendedor Sintético',
      active: false,
      firstResponse: {
        samples: 3,
        medianMinutes: 14,
        p90Minutes: null,
        openCount: 1,
        oldestOpenMinutes: 22,
        closedWithoutReply: 0,
      },
      claim: { samples: 0, medianMinutes: null, p90Minutes: null },
      unansweredNow: { count: 2, oldestWaitingMinutes: 31 },
      unansweredEpisodes: { count: 4 },
    });
  return {
    from: '2026-10-09',
    to: '2026-10-15',
    days,
    scope: manager ? 'team' : 'self',
    generatedAt: QUEUE.generatedAt,
    businessHours: BUSINESS_HOURS,
    rows,
    ...(manager
      ? { team: { unclaimedHandoffs: { count: 3, oldestWaitingMinutes: 42 } } }
      : {}),
  };
}

/** MET-06..08: declared losses by reason, never the free text.
 * @param {boolean} manager @param {number} days */
export function lossMetrics(manager, days = 7) {
  const reasons = (/** @type {Record<string, number>} */ counts) => ({
    preco: 0,
    prazo: 0,
    concorrente: 0,
    silencio: 0,
    indisponivel: 0,
    outro: 0,
    ...counts,
  });
  const rows = [
    {
      userId: 'seller-1',
      name: 'Atendente Sintética',
      active: true,
      lostCount: 3,
      reopenedByCustomerCount: 1,
      byReason: reasons({ preco: 2, prazo: 1 }),
    },
  ];
  if (manager)
    rows.push({
      userId: 'seller-2',
      name: 'Vendedor Sintético',
      active: false,
      lostCount: 2,
      reopenedByCustomerCount: 0,
      byReason: reasons({ silencio: 1, outro: 1 }),
    });
  return {
    from: '2026-10-09',
    to: '2026-10-15',
    days,
    scope: manager ? 'team' : 'self',
    generatedAt: QUEUE.generatedAt,
    rows,
    ...(manager
      ? {
          totals: {
            lostCount: 5,
            reopenedByCustomerCount: 1,
            byReason: reasons({ preco: 2, prazo: 1, silencio: 1, outro: 1 }),
          },
        }
      : {}),
  };
}

/** The oldest handoffs nobody took, as the Inbox list returns them. */
export function waitingConversations() {
  return [
    {
      id: 'waiting-1',
      contact: { label: 'Conversa Sintética' },
      lastMessage: { preview: 'Mensagem sintética de espera' },
      handoff: {
        id: 'handoff-1',
        status: 'pending',
        createdAt: '2026-10-15T13:00:00.000Z',
        dueAt: '2026-10-15T13:30:00.000Z',
      },
    },
    {
      id: 'waiting-2',
      contact: { label: 'Cliente em Espera' },
      lastMessage: { preview: 'Outra mensagem sintética' },
      handoff: {
        id: 'handoff-2',
        status: 'pending',
        createdAt: '2026-10-15T14:52:00.000Z',
        dueAt: '2026-10-15T15:22:00.000Z',
      },
    },
  ];
}

/** @param {string} key */
export function ordersSummary(key) {
  const byPeriod = /** @type {Record<string, [number, number, string]>} */ ({
    '7dias': [5, 1_230_000, '2026-10-09'],
    hoje: [1, 180_000, '2026-10-15'],
    mes: [9, 2_480_000, '2026-10-01'],
  });
  const [confirmedCount, soldAmountCents, from] = byPeriod[key];
  return {
    averageTicketCents: 0,
    confirmedCount: 40,
    daily: DAILY.map((day) => ({ ...day })),
    deliveries: {
      dueSoonCount: 4,
      dueSoonUntil: '2026-10-21',
      oldestOverdueOn: '2026-10-09',
      overdueCount: 2,
    },
    pendingCount: 6,
    period: {
      confirmedCount,
      from,
      key,
      soldAmountCents,
      timeZone: 'America/Sao_Paulo',
      to: '2026-10-15',
    },
    soldAmountCents: 9_000_000,
    storeNewCount: 0,
    storeNewOldestPaidAt: null,
    today: '2026-10-15',
    totalPiecesSold: 0,
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{manager?: boolean, queue?: Record<string, any>}} [options]
 */
export async function mockPainel(
  page,
  {
    manager = true,
    queue = { ...QUEUE, unanswered: manager ? QUEUE.unanswered : null },
  } = {},
) {
  /** @type {string[]} */
  const periods = [];
  /** @type {URLSearchParams[]} */
  const orderLists = [];
  /** @type {URLSearchParams[]} */
  const inboxLists = [];
  let actions = actionItems();
  /** @type {{path: string, method: string, body: any, key: string|undefined}[]} */
  const writes = [];
  let actionReads = 0;
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        body: JSON.stringify(body),
        contentType: 'application/json',
        status,
      });
    if (url.pathname === '/api/v1/sessions/current') {
      return json({
        user: {
          capabilities: manager ? ['COMMERCIAL_ADMIN'] : [],
          functionName: 'Vendedor',
          id: manager ? 'admin-1' : 'seller-1',
          name: manager ? 'Gestor Sintético' : 'Atendente Sintética',
        },
      });
    }
    if (url.pathname === '/api/v1/events') {
      return route.fulfill({
        body: 'retry: 60000\n\n: connected\n\n',
        contentType: 'text/event-stream',
      });
    }
    if (url.pathname === '/api/v1/orders/summary') {
      const key = url.searchParams.get('period') ?? 'hoje';
      periods.push(key);
      return json(ordersSummary(key));
    }
    if (url.pathname === '/api/v1/inbox/summary') return json(queue);
    if (url.pathname === '/api/v1/dashboard/actions') {
      actionReads += 1;
      return json({
        generatedAt: QUEUE.generatedAt,
        today: '2026-10-15',
        items: actions,
        hasMore: false,
      });
    }
    if (url.pathname === '/api/v1/dashboard/performance')
      return json(
        performanceSummary(manager, Number(url.searchParams.get('days') ?? 7)),
      );
    if (url.pathname === '/api/v1/dashboard/metrics/service')
      return json(
        serviceMetrics(manager, Number(url.searchParams.get('days') ?? 7)),
      );
    if (url.pathname === '/api/v1/dashboard/metrics/losses')
      return json(
        lossMetrics(manager, Number(url.searchParams.get('days') ?? 7)),
      );
    if (
      /^\/api\/v1\/(?:orders\/[^/]+\/(?:payment|delivery)-confirmation|dashboard\/actions\/[^/]+\/decision)$/u.test(
        url.pathname,
      )
    ) {
      const body = route.request().postDataJSON();
      writes.push({
        path: url.pathname,
        method: route.request().method(),
        body,
        key: route.request().headers()['idempotency-key'],
      });
      const item = url.pathname.includes('/decision')
        ? actions.find(
            (row) => row.id === decodeURIComponent(url.pathname.split('/')[5]),
          )
        : actions.find(
            (row) =>
              row.targetType === 'order' &&
              row.targetId === url.pathname.split('/')[4],
          );
      if (!item || body.expectedVersion !== item.targetVersion)
        return json({ code: 'VERSION_CONFLICT' }, 409);
      if (url.pathname.endsWith('/decision')) {
        item.decisionVersion += 1;
        if (body.decision === 'dismiss')
          actions = actions.filter((row) => row.id !== item.id);
        else if (body.decision === 'resume') {
          item.deferred = false;
          item.remindAt = null;
        } else {
          item.deferred = true;
          item.remindAt = body.remindAt;
        }
        return json({
          id: item.id,
          decisionVersion: item.decisionVersion,
          remindAt: item.remindAt,
          decision: body.decision,
        });
      }
      const order = item.order;
      if (!order) return json({ code: 'NOT_FOUND' }, 404);
      if (url.pathname.endsWith('/payment-confirmation'))
        order.paidOn = body.paidOn;
      else order.deliveredOn = '2026-10-15';
      order.version += 1;
      item.targetVersion = order.version;
      item.sourceRevision = `revision-${order.version}`;
      if (order.paidOn && order.deliveredOn)
        actions = actions.filter((row) => row.id !== item.id);
      return json({ order });
    }
    if (url.pathname === '/api/v1/orders/delivery-tasks')
      return json({ items: [] });
    if (url.pathname === '/api/v1/orders') {
      orderLists.push(url.searchParams);
      return json({
        counts: { confirmado: 0, pendente: 0 },
        items: [],
        nextCursor: null,
      });
    }
    if (url.pathname === '/api/v1/inbox/conversations') {
      // The Inbox also reads one-item lists to count its tabs; only the
      // list the person sees (limit 100) is recorded.
      if (url.searchParams.get('limit') !== '1') {
        inboxLists.push(url.searchParams);
      }
      // The manager's Dashboard reads the five oldest waiting handoffs.
      if (
        url.searchParams.get('pendingHandoff') === 'true' &&
        url.searchParams.get('limit') === '5'
      )
        return json({
          hasMore: false,
          items: waitingConversations(),
          totalCount: 2,
        });
      return json({ hasMore: false, items: [], totalCount: 0 });
    }
    if (url.pathname === '/api/v1/users/assignable') {
      return json({
        users: [
          { id: 'seller-1', name: 'Atendente Sintética' },
          { id: 'seller-2', name: 'Vendedor Sintético' },
        ],
      });
    }
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return {
    inboxLists,
    orderLists,
    periods,
    writes,
    actionReads: () => actionReads,
    setActions: (/** @type {any[]} */ value) => {
      actions = value;
    },
  };
}
