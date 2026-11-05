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
      let matches = items.filter(
        (item) =>
          Boolean(item.archivedAt) ===
          (url.searchParams.get('archived') === 'true'),
      );
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
      // The urgency fixture is already in the official wire order; the UI
      // must preserve it rather than deriving a second priority model.
      if (url.searchParams.get('sort') !== 'urgency')
        matches = [...matches].sort((left, right) =>
          String(left.queuePosition ?? '').localeCompare(
            String(right.queuePosition ?? ''),
          ),
        );
      const totalCount =
        options.totalCounts?.[queue ?? 'all'] ?? matches.length;
      const limit = Number(url.searchParams.get('limit') ?? 100);
      const start =
        url.searchParams.get('cursor') === 'synthetic-next' ? 100 : 0;
      return route.fulfill({
        json: {
          items: matches.slice(start, start + limit),
          totalCount,
          nextCursor: matches.length > start + limit ? 'synthetic-next' : null,
        },
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

test('INBOX-UX-02: explicit Atender shows actionable customers, oldest wait first, in two lines', async ({
  page,
}, testInfo) => {
  const { queries } = await setup(page);
  await page.goto('/inbox?situacao=atender');
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

test('INBOX-UX-05: defaults to Todas in official urgency order, retaining other owners, automation and terminal context', async ({
  page,
}) => {
  const existing = fixtures();
  const ids = [
    'unsupported',
    'pending-ready',
    'reply',
    'incomplete',
    'unproven',
    'ready',
    'other',
    'assistant',
    'closed',
  ];
  const failed = conversation('failed', {
    deliveryIssue: { status: 'failed', occurredAt: '2026-11-03T11:55:00.000Z' },
    requiresAttention: true,
    updatedAt: '2026-11-03T11:59:00.000Z',
  });
  const urgent = conversation('urgent', {
    assignedUser: null,
    handoff: pending('urgent', 'urgency', '2026-11-03T11:40:00.000Z'),
    waitingSince: '2026-11-03T11:40:00.000Z',
    queuePosition: '2026-11-03T11:40:00.000Z',
  });
  // The fixed wire sequence comes from the official API priority groups.
  // It intentionally differs from waiting/updatedAt order: no local resort.
  const ordered = [
    failed,
    urgent,
    ...ids.map((id) => {
      const item = existing.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`Missing fixture ${id}`);
      return item;
    }),
  ];
  const { queries, writes } = await setup(page, {
    items: [...ordered, conversation('archived', { archivedAt: NOW })],
  });
  await page.goto('/inbox');
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  await expect(shortcuts.getByRole('button').first()).toHaveText(/^Atender/u);
  await expect(
    shortcuts.getByRole('button', { name: /^Todas/u }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.inbox-list .conv-name')).toHaveText(
    ordered.map((item) => item.contact.label),
  );
  await expect(row(page, 'archived')).toHaveCount(0);
  await expect(page.locator('.inbox-list-summary')).toContainText(
    'Mais urgentes primeiro',
  );
  await expect(page.getByRole('group', { name: 'Filtro:' })).toHaveCount(0);
  await expect(
    page.getByRole('dialog', { name: 'Filtrar conversas' }),
  ).toBeHidden();
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
      queries.some(
        (query) =>
          query.limit !== '1' &&
          !query.workQueue &&
          query.sort === 'urgency' &&
          query.archived === 'false' &&
          !query.assignedUserId &&
          !query.unassignedHumanHandoff,
      ),
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
    .getByRole('button', { name: 'Detalhes do atendimento', exact: true })
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
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
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

test('INBOX-UX-06: the horizontal shortcuts precede the workspace and preserve official selection', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const { writes } = await setup(page);
  await page.goto('/inbox');
  const shortcuts = page.getByRole('group', { name: 'Atalhos da Caixa' });
  await expect(shortcuts.getByRole('button')).toHaveText([
    /^Atender/u,
    /^Fechar pedidos/u,
    /^Todas/u,
  ]);
  const controls = await shortcuts.getByRole('button').all();
  controls.push(page.getByRole('button', { name: /^Filtros/u }));
  const workspace = await page.locator('.inbox-workspace').boundingBox();
  if (!workspace) throw new Error('Workspace must be visible');
  let previousRight = 0;
  let firstTop = null;
  for (const control of controls) {
    await expect(control).toBeInViewport({ ratio: 1 });
    const box = await control.boundingBox();
    if (!box) throw new Error('Filter controls must be visible');
    expect(box.y + box.height).toBeLessThanOrEqual(workspace.y);
    expect(box.x).toBeGreaterThanOrEqual(previousRight);
    firstTop ??= box.y;
    expect(Math.abs(box.y - firstTop)).toBeLessThanOrEqual(4);
    previousRight = box.x + box.width;
  }
  await expect(
    shortcuts.getByRole('button', { name: /^Todas/u }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toEqual([]);
});

test('INBOX-UX-06: sheet drafts apply explicitly, discard with Escape and restore focus', async ({
  page,
}) => {
  const { queries, writes } = await setup(page);
  await page.goto('/inbox');
  await expect(row(page, 'other')).toBeVisible();
  const filters = page.getByRole('button', { name: /^Filtros/u });
  await filters.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Filtrar conversas' });
  const situation = sheet.getByRole('group', { name: 'Situação', exact: true });
  const owner = sheet.getByRole('group', { name: 'Responsável', exact: true });
  await expect(sheet).toBeVisible();
  await expect(
    situation.getByRole('radio', { name: 'Todas', exact: true }),
  ).toBeFocused();
  const before = queries.filter((query) => query.limit !== '1').length;
  await owner.getByRole('radio', { name: 'Minhas', exact: true }).check();
  expect(queries.filter((query) => query.limit !== '1')).toHaveLength(before);
  await expect(row(page, 'other')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await filters.press('Enter');
  await expect(
    owner.getByRole('radio', { name: 'Todas', exact: true }),
  ).toBeChecked();
  await owner.getByRole('radio', { name: 'Minhas', exact: true }).check();
  await sheet
    .getByRole('button', { name: 'Ver resultados', exact: true })
    .click();
  await expect(sheet).toBeHidden();
  await expect(filters).toBeFocused();
  await expect
    .poll(() => queries.filter((query) => query.limit !== '1').at(-1))
    .toMatchObject({
      archived: 'false',
      sort: 'urgency',
      assignedUserId: OWNER,
    });
  await expect(row(page, 'other')).toHaveCount(0);
  await filters.press('Enter');
  const beforeClear = queries.filter((query) => query.limit !== '1').length;
  await sheet
    .getByRole('button', { name: 'Limpar filtros', exact: true })
    .click();
  await expect(
    owner.getByRole('radio', { name: 'Todas', exact: true }),
  ).toBeChecked();
  expect(queries.filter((query) => query.limit !== '1')).toHaveLength(
    beforeClear,
  );
  await sheet
    .getByRole('button', { name: 'Ver resultados', exact: true })
    .click();
  await expect
    .poll(() => queries.filter((query) => query.limit !== '1').at(-1))
    .toEqual({
      archived: 'false',
      sort: 'urgency',
      limit: '100',
    });
  await expect(row(page, 'other')).toBeVisible();
  expect(writes).toEqual([]);
});

for (const theme of ['light', 'dark']) {
  for (const width of [320, 390]) {
    test(`INBOX-UX-06: ${width}px keyboard triage and ${theme} accessibility`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.addInitScript((appearance) => {
        globalThis.localStorage.setItem('silmer-theme', appearance);
      }, theme);
      await setup(page);
      await page.goto('/inbox');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(row(page, 'unsupported')).toBeVisible();
      await expect(page.locator('.inbox-toolbar')).toBeVisible();
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
      await expect(page.locator('.inbox-toolbar')).toBeHidden();
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
}

test('INBOX-UX-06: applying a draft returns focus while its official list is loading', async ({
  page,
}) => {
  const { writes } = await setup(page);
  let release = () => {};
  const pending = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  await page.route('**/api/v1/inbox/conversations?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('workQueue') === 'closing' && params.get('limit') !== '1')
      await pending;
    await route.fallback();
  });
  await page.goto('/inbox');
  const filters = page.getByRole('button', { name: 'Filtros', exact: true });
  await filters.click();
  const sheet = page.getByRole('dialog', { name: 'Filtrar conversas' });
  const situation = sheet.getByRole('group', { name: 'Situação', exact: true });
  try {
    const requested = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname === '/api/v1/inbox/conversations' &&
        url.searchParams.get('workQueue') === 'closing' &&
        url.searchParams.get('limit') !== '1'
      );
    });
    await situation
      .getByRole('radio', { name: 'Fechar pedidos', exact: true })
      .check();
    await sheet
      .getByRole('button', { name: 'Ver resultados', exact: true })
      .click();
    await requested;
    await expect(sheet).toBeHidden();
    await expect(filters).toBeFocused();
  } finally {
    release();
  }
  await expect(
    page
      .getByRole('group', { name: 'Atalhos da Caixa' })
      .getByRole('button', { name: /^Fechar pedidos/u }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 'pending-ready')).toBeVisible();
  await expect(filters).toBeFocused();
  expect(writes).toEqual([]);
});

test('INBOX-UX-04: resizing an open filter to a phone closes it and leaves focus in the visible conversation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const { writes } = await setup(page);
  await page.goto('/inbox/ready');
  await expect(page.locator('.inbox-conversation')).toBeVisible();
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  const filters = page.getByRole('dialog', { name: 'Filtrar conversas' });
  await expect(
    filters
      .getByRole('group', { name: 'Situação', exact: true })
      .getByRole('radio', { name: 'Todas', exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.inbox-list-pane')).toBeHidden();
  await expect(filters).toBeHidden();
  await expect
    .poll(() =>
      page
        .locator('.inbox-conversation')
        .evaluate((element) =>
          element.contains(globalThis.document.activeElement),
        ),
    )
    .toBe(true);
  await expect(page.locator(':focus')).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await expect(page).toHaveURL('/inbox/ready');
  expect(writes).toEqual([]);
});

test('INBOX-UX-05: optional owner filters retain urgency and clearing restores unrestricted Todas', async ({
  page,
}) => {
  const { queries, writes } = await setup(page);
  await page.goto('/inbox');
  const filters = page.getByRole('button', { name: 'Filtros', exact: true });
  await filters.click();
  const panel = page.getByRole('dialog', { name: 'Filtrar conversas' });
  const owner = panel.getByRole('group', { name: 'Responsável', exact: true });
  await expect(
    panel
      .getByRole('group', { name: 'Situação', exact: true })
      .getByRole('radio', { name: 'Todas', exact: true }),
  ).toBeChecked();
  await owner.getByRole('radio', { name: 'Minhas', exact: true }).check();
  await panel
    .getByRole('button', { name: 'Ver resultados', exact: true })
    .click();
  await expect
    .poll(() => queries.filter((query) => query.limit !== '1').at(-1))
    .toMatchObject({
      archived: 'false',
      sort: 'urgency',
      assignedUserId: OWNER,
    });
  await expect(row(page, 'other')).toHaveCount(0);
  await filters.click();
  await owner
    .getByRole('radio', { name: 'Sem responsável', exact: true })
    .check();
  await panel
    .getByRole('button', { name: 'Ver resultados', exact: true })
    .click();
  await expect
    .poll(() => queries.filter((query) => query.limit !== '1').at(-1))
    .toMatchObject({
      archived: 'false',
      sort: 'urgency',
      unassignedHumanHandoff: 'true',
    });
  expect(
    queries.filter((query) => query.limit !== '1').at(-1)?.assignedUserId,
  ).toBeUndefined();
  await page
    .getByRole('button', {
      name: 'Remover filtro Sem responsável',
      exact: true,
    })
    .click();
  await expect
    .poll(() => queries.filter((query) => query.limit !== '1').at(-1))
    .toEqual({ archived: 'false', limit: '100', sort: 'urgency' });
  await expect(row(page, 'other')).toBeVisible();
  await expect(row(page, 'assistant')).toBeVisible();
  await expect(row(page, 'closed')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filtro:' })).toHaveCount(0);
  await expect(
    page
      .getByRole('group', { name: 'Atalhos da Caixa' })
      .getByRole('button', { name: /^Todas/u }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toEqual([]);
});

for (const [situation, queue, label] of [
  ['atender', 'attention', 'Atender'],
  ['fechar', 'closing', 'Fechar pedidos'],
]) {
  test(`INBOX-UX-05: explicit ${label} deep links retain their original queue`, async ({
    page,
  }) => {
    const { queries, writes } = await setup(page);
    await page.goto(`/inbox?situacao=${situation}`);
    await expect(
      page
        .getByRole('group', { name: 'Atalhos da Caixa' })
        .getByRole('button', { name: new RegExp(`^${label}`, 'u') }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect
      .poll(() => queries.filter((query) => query.limit !== '1').at(-1))
      .toEqual({ archived: 'false', limit: '100', workQueue: queue });
    await expect(page.locator('.inbox-list-summary')).toContainText(
      'Maior espera primeiro',
    );
    expect(writes).toEqual([]);
  });
}

function paginatedItems() {
  return Array.from({ length: 102 }, (_, index) =>
    conversation(`paged-${String(index).padStart(3, '0')}`),
  );
}

test('INBOX-UX-05: next page preserves official order, active conversation, draft and list scroll beyond 100', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const items = paginatedItems();
  const { queries, writes } = await setup(page, { items });
  await page.goto('/inbox/paged-000');
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await reply.fill('Rascunho sintético preservado ao carregar mais.');
  await expect(page.locator('.inbox-list .conv-name')).toHaveCount(100);
  await expect(page.locator('.inbox-list-summary')).toContainText(
    '100 de 102 conversas',
  );
  const more = page.getByRole('button', {
    name: 'Ver mais conversas',
    exact: true,
  });
  await more.scrollIntoViewIfNeeded();
  await more.focus();
  const before = await page
    .locator('.inbox-list')
    .evaluate((el) => el.scrollTop);
  await page.keyboard.press('Enter');
  await expect(page.locator('.inbox-list .conv-name')).toHaveText(
    items.map((item) => item.contact.label),
  );
  await expect(row(page, 'paged-100')).toBeFocused();
  await expect(reply).toHaveValue(
    'Rascunho sintético preservado ao carregar mais.',
  );
  await expect(page).toHaveURL('/inbox/paged-000');
  await expect(row(page, 'paged-000')).toHaveAttribute('aria-current', 'true');
  expect(
    await page.locator('.inbox-list').evaluate((el) => el.scrollTop),
  ).toBeCloseTo(before, 0);
  await expect(more).toHaveCount(0);
  expect(queries).toContainEqual({
    archived: 'false',
    limit: '100',
    sort: 'urgency',
    cursor: 'synthetic-next',
  });
  expect(writes).toEqual([]);
});

test('INBOX-UX-05: changing filters aborts a pending page and excludes its late response', async ({
  page,
}) => {
  const { queries, writes } = await setup(page, { items: paginatedItems() });
  let release = () => {};
  let responded = () => {};
  const pendingPage = new Promise((resolve) => {
    release = () => resolve(null);
  });
  const pageResponded = new Promise((resolve) => {
    responded = () => resolve(null);
  });
  await page.route('**/api/v1/inbox/conversations?**', async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor'))
      return route.fallback();
    await pendingPage;
    try {
      await route.fulfill({
        json: {
          items: [conversation('stale-page')],
          totalCount: 103,
          nextCursor: null,
        },
      });
    } finally {
      responded();
    }
  });
  await page.goto('/inbox');
  const requested = page.waitForRequest((request) =>
    new URL(request.url()).searchParams.has('cursor'),
  );
  await page
    .getByRole('button', { name: 'Ver mais conversas', exact: true })
    .click();
  await requested;
  const aborted = page.waitForEvent('requestfailed', (request) =>
    new URL(request.url()).searchParams.has('cursor'),
  );
  await page
    .getByRole('group', { name: 'Atalhos da Caixa' })
    .getByRole('button', { name: /^Atender/u })
    .click();
  await aborted;
  release();
  await pageResponded;
  await expect
    .poll(
      () => queries.filter((query) => query.limit !== '1').at(-1)?.workQueue,
    )
    .toBe('attention');
  await expect(page.locator('.inbox-list .conv-name')).toHaveCount(100);
  await expect(row(page, 'stale-page')).toHaveCount(0);
  await expect(page.locator('.inbox-list-summary')).toContainText(
    'Maior espera primeiro',
  );
  expect(writes).toEqual([]);
});

test('INBOX-UX-05: page failure keeps loaded rows and retry deduplicates without losing keyboard focus', async ({
  page,
}) => {
  const items = paginatedItems();
  const { writes } = await setup(page, { items });
  const cursors = /** @type {string[]} */ ([]);
  await page.route('**/api/v1/inbox/conversations?**', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (!cursor) return route.fallback();
    cursors.push(cursor);
    if (cursors.length === 1)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE' } },
      });
    return route.fulfill({
      json: {
        items: [items[99], items[100], items[101]],
        totalCount: 103,
        nextCursor: null,
      },
    });
  });
  await page.goto('/inbox');
  const more = page.getByRole('button', {
    name: 'Ver mais conversas',
    exact: true,
  });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('list', { name: 'Conversas' }).getByRole('alert'),
  ).toContainText('as conversas já carregadas foram preservadas.');
  await expect(more).toBeFocused();
  await expect(page.locator('.inbox-list .conv-name')).toHaveCount(100);
  await page.keyboard.press('Enter');
  await expect(page.locator('.inbox-list .conv-name')).toHaveText(
    items.map((item) => item.contact.label),
  );
  await expect(row(page, 'paged-099')).toHaveCount(1);
  await expect(row(page, 'paged-100')).toBeFocused();
  await expect(page.locator('.inbox-list-summary')).toContainText(
    '102 de 103 conversas',
  );
  expect(cursors).toEqual(['synthetic-next', 'synthetic-next']);
  expect(writes).toEqual([]);
});

test('INBOX-UX-05: a repeated cursor is reported without appending an invalid page', async ({
  page,
}) => {
  const items = paginatedItems();
  const { writes } = await setup(page, { items });
  let requests = 0;
  await page.route('**/api/v1/inbox/conversations?**', async (route) => {
    if (!new URL(route.request().url()).searchParams.has('cursor'))
      return route.fallback();
    requests += 1;
    return route.fulfill({
      json: {
        items: [items[100]],
        totalCount: 102,
        nextCursor: 'synthetic-next',
      },
    });
  });
  await page.goto('/inbox');
  await page
    .getByRole('button', { name: 'Ver mais conversas', exact: true })
    .click();
  await expect(
    page.getByRole('list', { name: 'Conversas' }).getByRole('alert'),
  ).toContainText('A lista mudou. Atualize a lista para continuar;');
  await expect(page.locator('.inbox-list .conv-name')).toHaveCount(100);
  await expect(row(page, 'paged-100')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Atualizar lista', exact: true }),
  ).toBeVisible();
  expect(requests).toBe(1);
  expect(writes).toEqual([]);
});

test('INBOX-UX-05: an invalid cursor offers a fresh first page without repeating it or losing the draft', async ({
  page,
}) => {
  const items = paginatedItems();
  const { writes } = await setup(page, { items });
  const reads = /** @type {Array<string|null>} */ ([]);
  let invalidSeen = false;
  let recoveryFailures = 1;
  await page.route('**/api/v1/inbox/conversations?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get('limit') === '100') reads.push(params.get('cursor'));
    if (params.has('cursor')) {
      invalidSeen = true;
      return route.fulfill({
        status: 400,
        json: { error: { code: 'INVALID_CURSOR' } },
      });
    }
    if (invalidSeen && params.get('limit') === '100' && recoveryFailures > 0) {
      recoveryFailures -= 1;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'UNAVAILABLE' } },
      });
    }
    return route.fallback();
  });
  await page.goto('/inbox/paged-000');
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await reply.fill('Rascunho preservado depois do cursor inválido.');
  await page
    .getByRole('button', { name: 'Ver mais conversas', exact: true })
    .click();
  await expect(
    page.getByRole('list', { name: 'Conversas' }).getByRole('alert'),
  ).toContainText('A lista mudou.');
  await expect(page.locator('.inbox-list .conv-name')).toHaveCount(100);
  const refresh = page.getByRole('button', {
    name: 'Atualizar lista',
    exact: true,
  });
  await refresh.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText(
    'Não foi possível atualizar a Caixa',
  );
  await expect(refresh).toBeFocused();
  await expect(page.locator('.inbox-list .conv-name')).toHaveCount(100);
  await expect(reply).toHaveValue(
    'Rascunho preservado depois do cursor inválido.',
  );
  await page.keyboard.press('Enter');
  await expect.poll(() => reads).toEqual([null, 'synthetic-next', null, null]);
  await expect(refresh).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Ver mais conversas', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Ver mais conversas', exact: true }),
  ).toBeFocused();
  await expect(reply).toHaveValue(
    'Rascunho preservado depois do cursor inválido.',
  );
  await expect(row(page, 'paged-000')).toHaveAttribute('aria-current', 'true');
  await expect(page).toHaveURL('/inbox/paged-000');
  expect(writes).toEqual([]);
});
