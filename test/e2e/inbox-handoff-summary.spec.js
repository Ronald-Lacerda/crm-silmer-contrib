import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';

// INBOX-HANDOFF-01 / AGT-03: the seller opens a transferred conversation and
// reads what the agent handed over, without the summary moving focus.
const SUMMARY =
  'Motivo: Perguntou o valor. Atenção: Bordado em dry fit pede teste. ' +
  'Ficha: 5 de 9 (56%). ' +
  'Perguntas do cliente: • Vocês fazem parceria? • Qual o mínimo para revenda? ' +
  'Dica: Possível parceria/revenda.';

/**
 * @param {import('@playwright/test').Page} page
 * @param {{handoffStatus?: number, status?: 'pending'|'accepted'}} [options]
 */
async function setup(page, options = {}) {
  const status = options.status ?? 'pending';
  const conversations = [1, 2].map((number) => ({
    id: `conversation-${number}`,
    version: 4,
    channel: 'whatsapp',
    state: 'requer_atencao',
    automationState: 'human',
    automationEpoch: 2,
    assignedUser:
      status === 'accepted'
        ? { id: 'seller-1', functionName: 'Vendedor' }
        : null,
    handoff:
      number === 1
        ? {
            createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
            dueAt: '2026-10-29T16:00:00.000Z',
            id: 'handoff-1',
            reasonCode: 'price_before_quote',
            status,
            targetRole: 'Vendedor',
            version: 1,
          }
        : null,
    contact: {
      id: `contact-${number}`,
      label: `Cliente sintético ${number}`,
      externalId: '5500000000000',
    },
    lastMessage: {
      id: `initial-${number}`,
      type: 'text',
      preview: 'Mensagem inicial',
      direction: 'inbound',
    },
    requiresAttention: number === 1,
  }));
  const summaryRequests = /** @type {string[]} */ ([]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    if (path === '/api/v1/sessions/current')
      return route.fulfill({
        json: {
          user: { id: 'seller-1', functionName: 'Vendedor', capabilities: [] },
        },
      });
    if (path === '/api/v1/events') return;
    if (path === '/api/v1/users/assignable')
      return route.fulfill({
        json: { users: [{ id: 'seller-1', name: 'Vendedor sintético' }] },
      });
    if (path === '/api/v1/inbox/conversations')
      return route.fulfill({
        json: { items: conversations, totalCount: 2, nextCursor: null },
      });
    if (/^\/api\/v1\/inbox\/conversations\/[^/]+\/subjects$/.test(path))
      return route.fulfill({
        json: {
          currentSubjectId: null,
          needsSubjectMessageIds: [],
          links: [],
          orders: [],
          ordersHasMore: false,
          subjects: [],
        },
      });
    const handoff = /^\/api\/v1\/inbox\/conversations\/([^/]+)\/handoff$/.exec(
      path,
    );
    if (handoff) {
      summaryRequests.push(`${handoff[1]}${url.search}`);
      if (options.handoffStatus)
        return route.fulfill({
          status: options.handoffStatus,
          json: { error: { code: 'FORBIDDEN' } },
        });
      const conversation = conversations.find((item) => item.id === handoff[1]);
      return route.fulfill({
        headers: { 'cache-control': 'private, no-store' },
        json: {
          handoff: conversation?.handoff
            ? {
                createdAt: conversation.handoff.createdAt,
                id: conversation.handoff.id,
                reasonCode: conversation.handoff.reasonCode,
                status: conversation.handoff.status,
                summary: SUMMARY,
                version: 1,
              }
            : null,
        },
      });
    }
    const detail = /^\/api\/v1\/inbox\/conversations\/([^/]+)$/.exec(path);
    if (detail) {
      const conversation = conversations.find((item) => item.id === detail[1]);
      return route.fulfill({
        json: {
          conversation,
          messages: [conversation?.lastMessage],
          suggestion: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return { summaryRequests };
}

test('shows the handoff summary of a transferred conversation to the seller', async ({
  page,
}) => {
  const { summaryRequests } = await setup(page);
  await page.goto('/inbox/conversation-1');
  const heading = page.getByRole('heading', {
    level: 2,
    name: 'Cliente sintético 1',
  });
  await expect(heading).toBeVisible();

  const toggle = page.getByRole('button', { name: 'Resumo da transferência' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const summary = page.getByRole('region', { name: 'Resumo da transferência' });
  await expect(summary).toContainText('Motivo: Perguntou o valor.');
  await expect(summary).toContainText(
    'Atenção: Bordado em dry fit pede teste.',
  );
  await expect(summary).toContainText('Ficha: 5 de 9 (56%).');
  await expect(summary).toContainText('Dica: Possível parceria/revenda.');
  const questions = summary.getByRole('listitem').filter({
    hasText: /^(Vocês fazem parceria\?|Qual o mínimo para revenda\?)$/u,
  });
  await expect(questions).toHaveCount(2);

  // Loading the summary never takes the focus away from where the seller is.
  const focused = await page.evaluate(
    () =>
      globalThis.document.activeElement?.closest('.handoff-summary') !== null,
  );
  expect(focused).toBe(false);
  // The summary is PII: never in the URL, the address bar or browser storage.
  expect(summaryRequests).toEqual(['conversation-1']);
  expect(page.url()).not.toContain('Perguntou');
  const stored = await page.evaluate(() =>
    JSON.stringify({
      ...globalThis.localStorage,
      ...globalThis.sessionStorage,
    }),
  );
  expect(stored).not.toContain('Perguntou');

  // Keyboard: the disclosure collapses and expands with the focus kept on it.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Ficha: 5 de 9 (56%).')).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();

  const axe = await new AxeBuilder({ page })
    .include('.handoff-summary')
    .analyze();
  expect(axe.violations).toEqual([]);

  // Another conversation never shows the summary of the one before it.
  await page.goto('/inbox/conversation-2');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Cliente sintético 2' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Resumo da transferência' }),
  ).toHaveCount(0);
});

test('starts the summary closed once a seller took the conversation', async ({
  page,
}) => {
  await setup(page, { status: 'accepted' });
  await page.goto('/inbox/conversation-1');
  const toggle = page.getByRole('button', { name: 'Resumo da transferência' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(
    page.getByRole('region', { name: 'Resumo da transferência' }),
  ).toContainText('Ficha: 5 de 9 (56%).');
});

test('leaves the summary out when the reader may not read handoffs', async ({
  page,
}) => {
  const { summaryRequests } = await setup(page, { handoffStatus: 403 });
  await page.goto('/inbox/conversation-1');
  await expect(
    page.getByRole('heading', { level: 2, name: 'Cliente sintético 1' }),
  ).toBeVisible();
  await expect.poll(() => summaryRequests.length).toBe(1);
  await expect(
    page.getByRole('button', { name: 'Resumo da transferência' }),
  ).toHaveCount(0);
  await expect(page.getByText('Perguntou o valor.')).toHaveCount(0);
});
