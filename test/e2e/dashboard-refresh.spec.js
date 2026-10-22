import { expect, test } from '@playwright/test';

const QUEUE_SUMMARY = Object.freeze({
  assistant: {
    activeCount: 3,
    failedDeliveryCount: 0,
    lastReplyAt: '2026-10-15T14:58:00.000Z',
    stallMinutes: 10,
    stalledCount: 0,
  },
  generatedAt: '2026-10-15T15:00:00.000Z',
  mine: { awaitingReplyCount: 0, count: 0, oldestAwaitingSince: null },
  waitingHandoff: { count: 0, oldestSince: null, overdueCount: 0 },
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {{failFirst?: boolean}} [options]
 */
async function mockDashboard(page, options = {}) {
  let summaryReads = 0;
  let failNext = false;
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        body: JSON.stringify(body),
        contentType: 'application/json',
        status,
      });

    if (path === '/api/v1/sessions/current') {
      return json({
        user: {
          capabilities: ['COMMERCIAL_ADMIN'],
          id: 'admin-1',
          name: 'Administrador',
        },
      });
    }
    if (path === '/api/v1/events') {
      await eventGate;
      return route.fulfill({
        body: 'retry: 60000\n\nevent: inbox.order.changed\nid: evt-2\ndata: {"orderId":"order-1"}\n\n',
        contentType: 'text/event-stream',
        status: 200,
      });
    }
    if (path === '/api/v1/inbox/summary') {
      return json(QUEUE_SUMMARY);
    }
    if (path === '/api/v1/orders/delivery-tasks') return json({ items: [] });
    if (path === '/api/v1/orders/summary') {
      summaryReads += 1;
      if ((summaryReads === 1 && options.failFirst) || failNext) {
        failNext = false;
        return json({ code: 'UNAVAILABLE' }, 503);
      }
      const confirmedCount = summaryReads >= 3 ? 3 : 2;
      const soldAmountCents = summaryReads >= 3 ? 450000 : 250000;
      return json({
        averageTicketCents: summaryReads >= 3 ? 150000 : 125000,
        confirmedCount,
        pendingCount: 1,
        soldAmountCents,
        totalPiecesSold: 300,
        period: {
          confirmedCount,
          from: '2026-10-15',
          key: 'hoje',
          soldAmountCents,
          timeZone: 'America/Sao_Paulo',
          to: '2026-10-15',
        },
        today: '2026-10-15',
      });
    }
    return json({ code: 'NOT_FOUND' }, 404);
  });

  return {
    failNextRefresh() {
      failNext = true;
      releaseEvent();
    },
    summaryReads: () => summaryReads,
  };
}

test('keeps loaded sales visible after a live refresh fails and retries on demand', async ({
  page,
}) => {
  const mock = await mockDashboard(page);
  await page.goto('/dashboard');
  await expect(page.getByText('R$ 2.500,00')).toBeVisible();

  mock.failNextRefresh();
  await expect(page.getByRole('alert')).toContainText(
    'Os dados exibidos podem estar desatualizados.',
  );
  await expect(page.getByText('R$ 2.500,00')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Dashboard indisponível' }),
  ).toHaveCount(0);
  expect(mock.summaryReads()).toBe(2);

  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('R$ 4.500,00')).toBeVisible();
});

test('shows a clear initial error and recovers with retry', async ({
  page,
}) => {
  await mockDashboard(page, { failFirst: true });
  await page.goto('/dashboard');

  await expect(
    page.getByRole('heading', { name: 'Dashboard indisponível' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tentar novamente' }).click();
  await expect(page.getByText('R$ 2.500,00')).toBeVisible();
});
