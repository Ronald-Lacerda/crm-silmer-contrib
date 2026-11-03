import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// INBOX-UX-02: synthetic seller decisions, never real customer records.
const NOW = '2026-11-03T12:00:00.000Z';
const OWNER = 'seller-synthetic-1';
const OTHER = 'seller-synthetic-2';

/** @param {string} id @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function conversation(id, overrides = {}) {
  return {
    id,
    version: 4,
    channel: 'whatsapp',
    state: 'em_atendimento',
    automationState: 'human',
    automationEpoch: 2,
    assignedUser: { id: OWNER, functionName: 'Vendedor' },
    handoff: null,
    contact: {
      id: `contact-${id}`,
      label: `Cliente sintético ${id}`,
      externalId: '5500000000000',
    },
    lastMessage: {
      id: `message-${id}`,
      type: 'text',
      preview: 'Mensagem sintética para testar a triagem.',
      direction: 'inbound',
      occurredAt: '2026-11-03T11:00:00.000Z',
    },
    updatedAt: '2026-11-03T11:00:00.000Z',
    waitingSince: '2026-11-03T11:00:00.000Z',
    queuePosition: '2026-11-03T11:00:00.000Z',
    requiresAttention: false,
    order: null,
    ...overrides,
  };
}

/** @param {string} id @param {string} reasonCode @param {string} createdAt */
function pending(id, reasonCode, createdAt) {
  return {
    createdAt,
    dueAt: NOW,
    id: `handoff-${id}`,
    reasonCode,
    status: 'pending',
    targetRole: 'Vendedor',
    version: 1,
  };
}

function fixtures() {
  const readyOrder = {
    id: 'order-ready',
    number: '01-CRM',
    status: 'pendente',
    readyForConfirmation: true,
  };
  return [
    conversation('reply'),
    conversation('ready', {
      order: readyOrder,
      waitingSince: '2026-11-03T11:12:00.000Z',
      queuePosition: '2026-11-03T11:12:00.000Z',
    }),
    conversation('unsupported', {
      assignedUser: null,
      state: 'requer_atencao',
      handoff: pending(
        'unsupported',
        'unsupported',
        '2026-11-02T09:00:00.000Z',
      ),
      // A later automatic notice never resets an already pending handoff.
      lastMessage: {
        id: 'automatic-notice',
        type: 'text',
        preview: 'Aviso automático sintético.',
        direction: 'outbound',
        authorKind: 'assistant',
        occurredAt: '2026-11-03T11:59:00.000Z',
      },
      updatedAt: '2026-11-03T11:59:00.000Z',
      waitingSince: '2026-11-02T09:00:00.000Z',
      queuePosition: '2026-11-02T09:00:00.000Z',
      requiresAttention: true,
    }),
    conversation('pending-ready', {
      assignedUser: null,
      state: 'requer_atencao',
      handoff: pending(
        'pending-ready',
        'briefing_complete',
        '2026-11-03T10:00:00.000Z',
      ),
      waitingSince: '2026-11-03T10:00:00.000Z',
      queuePosition: '2026-11-03T10:00:00.000Z',
      order: { ...readyOrder, id: 'order-pending-ready', number: '02-CRM' },
    }),
    conversation('incomplete', {
      waitingSince: '2026-11-03T11:03:00.000Z',
      queuePosition: '2026-11-03T11:03:00.000Z',
      order: {
        ...readyOrder,
        id: 'order-incomplete',
        number: '03-CRM',
        readyForConfirmation: false,
      },
      handoff: {
        ...pending(
          'incomplete',
          'briefing_complete',
          '2026-11-03T11:00:00.000Z',
        ),
        status: 'accepted',
      },
    }),
    conversation('unproven', {
      waitingSince: '2026-11-03T11:06:00.000Z',
      queuePosition: '2026-11-03T11:06:00.000Z',
      // An older API's missing readiness is unknown, never proof of readiness.
      order: { id: 'order-unproven', number: '04-CRM', status: 'pendente' },
    }),
    conversation('other', {
      assignedUser: { id: OTHER, functionName: 'Vendedor' },
      order: { ...readyOrder, id: 'order-other', number: '05-CRM' },
      waitingSince: null,
      queuePosition: null,
    }),
    conversation('assistant', {
      assignedUser: null,
      state: 'nova',
      automationState: 'assistant',
      waitingSince: null,
      queuePosition: null,
    }),
    conversation('closed', {
      state: 'encerrada',
      terminalAt: '2026-11-03T10:00:00.000Z',
      waitingSince: null,
      queuePosition: null,
    }),
  ];
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{items?: Record<string, any>[], totalCounts?: Record<string, number>}} [options]
 */
async function setup(page, options = {}) {
  await page.clock.setFixedTime(new Date(NOW));
  const items = options.items ?? fixtures();
  /** @type {Record<string, string>[]} */
  const queries = [];
  /** @type {string[]} */
  const writes = [];
  /** @param {Record<string, any>} item */
  const mineOrUnassigned = (item) =>
    !item.assignedUser || item.assignedUser.id === OWNER;
  /** @param {Record<string, any>} item */
  const active = (item) => !item.terminalAt && item.state !== 'encerrada';
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (req.method() !== 'GET') {
      writes.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 405, json: {} });
    }
    if (path === '/api/v1/sessions/current')
      return route.fulfill({
        json: {
          user: {
            id: OWNER,
            name: 'Vendedor sintético',
            functionName: 'Vendedor',
            capabilities: [],
          },
        },
      });
    if (path === '/api/v1/events') return;
    if (path === '/api/v1/users/assignable')
      return route.fulfill({
        json: {
          users: [
            { id: OWNER, name: 'Vendedor sintético' },
            { id: OTHER, name: 'Colega sintético' },
          ],
        },
      });
    if (path === '/api/v1/inbox/conversations') {
      queries.push(Object.fromEntries(url.searchParams));
      const queue = url.searchParams.get('workQueue');
      let matches = items;
      if (queue === 'attention')
        matches = matches.filter(
          (item) =>
            active(item) && mineOrUnassigned(item) && item.queuePosition,
        );
      if (queue === 'closing')
        matches = matches.filter(
          (item) =>
            active(item) &&
            mineOrUnassigned(item) &&
            (item.reviewOrder ?? item.order)?.status === 'pendente' &&
            (item.reviewOrder ?? item.order)?.readyForConfirmation === true,
        );
      const assigned = url.searchParams.get('assignedUserId');
      if (assigned)
        matches = matches.filter((item) => item.assignedUser?.id === assigned);
      if (url.searchParams.get('unassignedHumanHandoff') === 'true')
        matches = matches.filter((item) => !item.assignedUser);
      const automation = url.searchParams.get('automationState');
      if (automation)
        matches = matches.filter((item) => item.automationState === automation);
      const handoff = url.searchParams.get('pendingHandoff');
      if (handoff !== null)
        matches = matches.filter(
          (item) =>
            (item.handoff?.status === 'pending') === (handoff === 'true'),
        );
      matches = [...matches].sort((left, right) =>
        String(left.queuePosition ?? '').localeCompare(
          String(right.queuePosition ?? ''),
        ),
      );
      const totalCount =
        options.totalCounts?.[queue ?? 'all'] ?? matches.length;
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return route.fulfill({
        json: { items: matches.slice(0, limit), totalCount, nextCursor: null },
      });
    }
    if (path.endsWith('/subjects'))
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
      const item = items.find((candidate) => candidate.id === handoff[1]);
      return route.fulfill({
        headers: { 'cache-control': 'private, no-store' },
        json: {
          handoff: item?.handoff
            ? {
                ...item.handoff,
                summary:
                  item.handoff.reasonCode === 'unsupported'
                    ? 'Conteúdo text requer atendimento humano no MVP.'
                    : 'Motivo: Pré-ficha completa. Atenção: Rever o prazo com o cliente.',
              }
            : null,
        },
      });
    }
    const explicitOrder = /^\/api\/v1\/orders\/([^/]+)$/.exec(path);
    if (explicitOrder) {
      const order = items
        .map((item) => item.reviewOrder)
        .find((candidate) => candidate?.id === explicitOrder[1]);
      return route.fulfill({
        json: {
          order: order
            ? {
                ...order,
                missingFields: [],
                totalPieces: 1,
                finalAmountCents: 1000,
                ficha: { items: [], summary: {} },
              }
            : null,
        },
      });
    }
    const order = /^\/api\/v1\/conversations\/([^/]+)\/order$/.exec(path);
    if (order) {
      const item = items.find((candidate) => candidate.id === order[1]);
      return route.fulfill({
        json: {
          order: item?.order
            ? {
                ...item.order,
                missingFields: item.order.readyForConfirmation
                  ? []
                  : ['finalAmount', 'paymentCondition'],
                ficha: { items: [], summary: {} },
              }
            : null,
        },
      });
    }
    const detail = /^\/api\/v1\/inbox\/conversations\/([^/]+)$/.exec(path);
    if (detail) {
      const item = items.find((candidate) => candidate.id === detail[1]);
      return route.fulfill({
        json: {
          conversation: item,
          messages: item ? [item.lastMessage] : [],
          suggestion: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  return { queries, writes };
}

/** @param {import('@playwright/test').Page} page @param {string} id */
function row(page, id) {
  return page.locator(`.conversation-row[data-conversation-id="${id}"]`);
}

test('INBOX-UX-02: starts with actionable customers, oldest wait first, in two lines', async ({
  page,
}, testInfo) => {
  const { queries } = await setup(page);
  await page.goto('/inbox');
  await expect(
    page.getByRole('group', { name: 'Atalhos da Caixa' }).getByRole('button', {
      name: /^Atender/u,
    }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() => queries.some((query) => query.workQueue === 'attention'))
    .toBe(true);
  await expect(page.locator('.inbox-list .conv-name')).toHaveText([
    'Cliente sintético unsupported',
    'Cliente sintético pending-ready',
    'Cliente sintético reply',
    'Cliente sintético incomplete',
    'Cliente sintético unproven',
    'Cliente sintético ready',
  ]);
  await expect(
    row(page, 'unsupported').locator('.conv-next-action'),
  ).toHaveText('Assumir atendimento');
  await expect(row(page, 'unsupported').locator('.conv-waiting')).toContainText(
    '1d',
  );
  await expect(row(page, 'unsupported').locator('.conv-waiting')).toContainText(
    '03h',
  );
  await expect(row(page, 'reply').locator('.conv-next-action')).toHaveText(
    'Responder cliente',
  );
  await expect(row(page, 'ready').locator('.conv-next-action')).toHaveText(
    'Revisar pedido',
  );
  await expect(
    row(page, 'pending-ready').locator('.conv-next-action'),
  ).toHaveText('Assumir e revisar pedido');
  await expect(row(page, 'incomplete')).not.toContainText('Revisar pedido');
  await expect(row(page, 'unproven')).not.toContainText('Revisar pedido');
  await expect(
    page.locator(
      '.inbox-list .conv-snippet, .inbox-list .conv-channel, .inbox-list .badge',
    ),
  ).toHaveCount(0);
  await expect(page.locator('.inbox-list')).not.toContainText(
    'Conteúdo não suportado',
  );
  await expect(row(page, 'other')).toHaveCount(0);
  await expect(row(page, 'assistant')).toHaveCount(0);
  await expect(row(page, 'closed')).toHaveCount(0);
  const waitingFits = await row(page, 'pending-ready').evaluate((element) => {
    const wait = element.querySelector('.conv-waiting');
    return (
      wait &&
      wait.getBoundingClientRect().right <=
        element.getBoundingClientRect().right
    );
  });
  expect(waitingFits).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('inbox-prioridades.png') });
});

test('INBOX-UX-02: global closing filter uses official readiness and API totals', async ({
  page,
}) => {
  const { queries, writes } = await setup(page, {
    totalCounts: { attention: 137, closing: 41, all: 200 },
  });
  await page.goto('/inbox');
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  await expect(
    shortcuts.getByRole('button', { name: /^Atender/u }),
  ).toContainText('137');
  const closing = shortcuts.getByRole('button', { name: /^Fechar pedidos/u });
  await expect(closing).toContainText('41');
  await closing.click();
  await expect(closing).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.inbox-list .conv-name')).toHaveText([
    'Cliente sintético pending-ready',
    'Cliente sintético ready',
  ]);
  await expect
    .poll(() =>
      queries.some(
        (query) => query.workQueue === 'closing' && query.limit !== '1',
      ),
    )
    .toBe(true);
  // A completed briefing without commercial readiness is not ready to close.
  await expect(row(page, 'incomplete')).toHaveCount(0);
  await expect(row(page, 'unproven')).toHaveCount(0);
  await expect(row(page, 'other')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('INBOX-UX-02: All retains other owners, automation and terminal context without granting actions', async ({
  page,
}) => {
  const { queries, writes } = await setup(page);
  await page.goto('/inbox');
  await page
    .getByRole('group', { name: 'Atalhos da Caixa' })
    .getByRole('button', { name: /^Todas/u })
    .click();
  await expect(row(page, 'other').locator('.conv-next-action')).toHaveText(
    'Com Colega sintético',
  );
  await expect(row(page, 'assistant').locator('.conv-next-action')).toHaveText(
    'Com o agente',
  );
  await expect(row(page, 'closed').locator('.conv-next-action')).toContainText(
    /encerrad/iu,
  );
  await expect
    .poll(() =>
      queries.some((query) => query.limit !== '1' && !query.workQueue),
    )
    .toBe(true);
  await row(page, 'other').click();
  await expect(page.locator('.conv-head')).toContainText('Colega sintético');
  await expect(
    page.getByRole('button', { name: 'Assumir atendimento', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([]);
});

test('INBOX-UX-02: a ready linked order has an explicit header link and matching detail even when the canonical order is incomplete', async ({
  page,
}) => {
  const item = conversation('linked', {
    order: {
      id: 'order-incomplete',
      number: '09-CRM',
      status: 'pendente',
      readyForConfirmation: false,
    },
    reviewOrder: {
      id: 'order-linked-ready',
      number: '07-CRM',
      status: 'pendente',
      readyForConfirmation: true,
    },
  });
  const { writes } = await setup(page, { items: [item] });
  await page.goto('/inbox');
  await page.getByRole('button', { name: /^Fechar pedidos/u }).click();
  await expect(row(page, 'linked').locator('.conv-next-action')).toHaveText(
    'Revisar pedido',
  );
  await expect(
    page
      .locator('.conv-head')
      .getByRole('link', { name: 'Abrir pedido 07-CRM, pendente' }),
  ).toHaveAttribute('href', '/pedidos/order-linked-ready?conversa=linked');
  await page
    .locator('.conv-actions')
    .getByRole('button', { name: 'Detalhes', exact: true })
    .click();
  const summary = page.locator('.context-order-summary');
  await expect(summary).toContainText('07-CRM');
  await expect(summary).not.toContainText('09-CRM');
  await expect(summary).toContainText('Pronto para gerar.');
  await expect(
    summary.getByRole('link', { name: 'Abrir pedido', exact: true }),
  ).toHaveAttribute('href', '/pedidos/order-linked-ready?conversa=linked');
  expect(writes).toEqual([]);
});

test('INBOX-UX-02: unsupported has a plain reason beside the chat and preserves its original record by keyboard', async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto('/inbox/unsupported');
  await expect(page.locator('.handoff-reason')).toContainText(
    'Agente não continuou',
  );
  await expect(page.locator('.conv-head')).toContainText('WhatsApp');
  await expect(page.locator('.conv-head')).toContainText('Aguardando vendedor');
  await expect(
    page
      .locator('.conv-head')
      .getByRole('button', { name: 'Assumir atendimento', exact: true }),
  ).toBeEnabled();
  await expect(
    page
      .locator('.inbox-takeover')
      .getByRole('button', { name: 'Assumir atendimento', exact: true }),
  ).toHaveCount(0);
  const toggle = page.getByRole('button', {
    name: 'Resumo da transferência',
    exact: true,
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const original = page.getByText(
    'Conteúdo text requer atendimento humano no MVP.',
    { exact: true },
  );
  await expect(original).toBeHidden();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(original).toBeVisible();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
  expect(writes).toEqual([]);
  // The change preserves commercially useful information for other handoffs.
  await page.goto('/inbox/pending-ready');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('region', { name: 'Resumo da transferência' }),
  ).toContainText('Rever o prazo com o cliente.');
});

for (const delivery of [
  { status: 'failed', label: 'Envio falhou — revisar' },
  { status: 'outcome_unknown', label: 'Envio incerto — verificar' },
]) {
  test(`INBOX-UX-02: ${delivery.status} stays actionable above order readiness and does not resend`, async ({
    page,
  }) => {
    const item = conversation('delivery', {
      order: {
        id: 'order-delivery',
        number: '06-CRM',
        status: 'pendente',
        readyForConfirmation: true,
      },
      lastMessage: {
        id: 'message-delivery',
        type: 'text',
        preview: 'Resposta sintética.',
        direction: 'outbound',
        authorKind: 'human',
        authorId: OWNER,
        deliveryStatus: delivery.status,
        status: delivery.status,
        deliveryErrorCode:
          delivery.status === 'failed' ? 'SEND_FAILED' : 'SEND_OUTCOME_UNKNOWN',
      },
      requiresAttention: true,
    });
    const earlierFailure = conversation('earlier-delivery', {
      order: item.order,
      deliveryIssue: {
        status: delivery.status,
        occurredAt: '2026-11-03T10:30:00.000Z',
      },
      // The customer wrote again after the unresolved outbound failure.
      // The operational warning must survive that newer inbound preview.
      requiresAttention: true,
    });
    const { writes } = await setup(page, { items: [item, earlierFailure] });
    await page.goto('/inbox');
    await expect(row(page, 'delivery').locator('.conv-next-action')).toHaveText(
      delivery.label,
    );
    await expect(
      row(page, 'earlier-delivery').locator('.conv-next-action'),
    ).toHaveText(delivery.label);
    await row(page, 'delivery').click();
    const notice = page.locator('.message-delivery-notice');
    await expect(notice).toBeVisible();
    await notice
      .getByText('Detalhes para suporte', { exact: true })
      .press('Enter');
    await expect(
      notice.getByText(item.lastMessage.deliveryErrorCode, { exact: true }),
    ).toBeVisible();
    expect(writes).toEqual([]);
  });
}

test('INBOX-UX-02: legacy data does not invent an elapsed wait or an unread signal', async ({
  page,
}) => {
  const legacy = conversation('legacy', {
    waitingSince: null,
    queuePosition: null,
    automationState: 'assistant',
    assignedUser: null,
    state: 'nova',
  });
  await setup(page, { items: [legacy] });
  await page.goto('/inbox');
  await page
    .getByRole('group', { name: 'Atalhos da Caixa' })
    .getByRole('button', { name: /^Todas/u })
    .click();
  await expect(row(page, 'legacy').locator('.conv-waiting')).toHaveCount(0);
  await expect(row(page, 'legacy').locator('.conv-next-action')).toHaveText(
    'Com o agente',
  );
  await expect(row(page, 'legacy')).not.toContainText(/não lid[ao]|atrasad/iu);
});

test('INBOX-UX-02: filter sheet still exposes situation and owner and restores focus', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/inbox');
  const filters = page.getByRole('button', { name: /^Filtros/u });
  await filters.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Filtrar conversas' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('group', { name: 'Situação' })).toBeVisible();
  await expect(sheet.getByRole('group', { name: 'Responsável' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
});

for (const theme of ['light', 'dark']) {
  test(`INBOX-UX-02: 320px keyboard triage and ${theme} accessibility`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addInitScript((appearance) => {
      globalThis.localStorage.setItem('silmer-theme', appearance);
    }, theme);
    await setup(page);
    await page.goto('/inbox');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(row(page, 'unsupported')).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await row(page, 'unsupported').focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: 'Cliente sintético unsupported',
      }),
    ).toBeFocused();
    await expect(
      page
        .locator('.conv-head')
        .getByRole('button', { name: 'Assumir atendimento', exact: true }),
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
