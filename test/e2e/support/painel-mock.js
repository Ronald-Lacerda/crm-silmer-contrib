// Mock da API do Painel (Dashboard por papel) com dados sintéticos. Uso:
// `const mock = await mockPainel(page, { manager: false })` antes de
// `page.goto(...)`; `mock.periods`, `mock.orderLists` e `mock.inboxLists`
// registram o que a tela pediu. `QUEUE` e `ordersSummary(key)` são as
// respostas da fila e do resumo de pedidos por período.

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
  waitingHandoff: {
    count: 3,
    oldestSince: '2026-10-15T09:00:00.000Z',
    overdueCount: 1,
  },
});

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
 * @param {{manager?: boolean}} [options]
 */
export async function mockPainel(page, { manager = true } = {}) {
  /** @type {string[]} */
  const periods = [];
  /** @type {URLSearchParams[]} */
  const orderLists = [];
  /** @type {URLSearchParams[]} */
  const inboxLists = [];
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
    if (url.pathname === '/api/v1/inbox/summary') return json(QUEUE);
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
      return json({ hasMore: false, items: [], totalCount: 0 });
    }
    if (url.pathname === '/api/v1/users/assignable') {
      return json({ items: [] });
    }
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return { inboxLists, orderLists, periods };
}
