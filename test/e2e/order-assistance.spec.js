import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockPainel } from './support/painel-mock.js';

// OA-01..12: fictional conversations only. This feature must never send a
// message to the customer; every write is inspected below.

/** @param {import('@playwright/test').Page} page
 * @param {{empty?: boolean, otherOwner?: boolean, stale?: boolean, blocked?: boolean, multiple?: boolean, delayDecision?: boolean}} [options]
 */
async function setup(page, options = {}) {
  const conversations = [1, 2].map((number) => ({
    id: `assistance-conversation-${number}`,
    version: 7,
    channel: 'whatsapp',
    state: 'em_atendimento',
    automationState: 'human',
    automationEpoch: 2,
    assignedUser: {
      id: options.otherOwner ? 'other-seller' : 'assistance-seller',
      functionName: 'Vendedor',
    },
    handoff: null,
    terminalAt: null,
    contact: {
      id: `assistance-contact-${number}`,
      label: `Cliente sintético ${number}`,
      externalId: '5500000000000',
    },
    lastMessage: {
      id: `assistance-message-${number}`,
      direction: 'inbound',
      type: 'text',
      preview: 'Pode fechar as 30 camisetas.',
      occurredAt: '2026-11-03T15:00:00.000Z',
      status: 'received',
    },
    requiresAttention: false,
  }));
  const original = {
    id: 'suggestion-1',
    version: 1,
    status: 'pending',
    productSummary: '30 camisetas',
    evidenceMessageId: 'assistance-message-1',
    sourceRevision: 4,
    createdAt: '2026-11-03T15:00:01.000Z',
  };
  /** @type {any[]} */
  let suggestions = options.empty ? [] : [{ ...original }];
  if (options.multiple)
    suggestions = Array.from({ length: 4 }, (_, index) => ({
      ...original,
      id: `suggestion-${index + 1}`,
      productSummary:
        '30 camisetas com personalização individual e informações adicionais para revisão humana',
    }));
  /** @type {any[]} */
  const evaluations = [];
  /** @type {{path:string,body:any,csrf?:string,key?:string}[]} */
  const writes = [];
  let releaseDecision = () => {};
  const decisionGate = new Promise((resolve) => {
    releaseDecision = () => resolve(null);
  });
  let nextStale = options.stale === true;
  let version = 7;
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'assistance-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({ status, json: body });
    if (path === '/api/v1/sessions/current')
      return json({
        user: {
          id: 'assistance-seller',
          functionName: 'Vendedor',
          capabilities: [],
        },
      });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n: connected\n\n',
      });
    if (path === '/api/v1/users/assignable') return json({ users: [] });
    if (path === '/api/v1/inbox/conversations')
      return json({ items: conversations, totalCount: 2, nextCursor: null });
    if (/\/subjects$/u.test(path))
      return json({
        subjects: [],
        orders: [],
        links: [],
        currentSubjectId: null,
        needsSubjectMessageIds: [],
        ordersHasMore: false,
      });
    if (/\/order-assistance$/u.test(path))
      return json({
        suggestions: path.includes('conversation-1/') ? suggestions : [],
        evaluations,
        ...(options.blocked ? { blockedReason: 'pending_order_exists' } : {}),
        sourceRevision: 4,
        conversationVersion: version,
      });
    if (/\/order-assistance\/decisions$/u.test(path)) {
      const body = request.postDataJSON();
      writes.push({
        path,
        body,
        csrf: request.headers()['x-csrf-token'],
        key: request.headers()['idempotency-key'],
      });
      if (options.delayDecision) await decisionGate;
      if (nextStale) {
        nextStale = false;
        version += 1;
        suggestions = [{ ...original, version: 2 }];
        return json({ error: { code: 'ORDER_ASSISTANCE_STALE' } }, 409);
      }
      const accepted = body.decision === 'accept';
      if (body.decision !== 'missed')
        suggestions = [
          {
            ...original,
            version: 2,
            status: accepted
              ? 'accepted'
              : body.decision === 'defer'
                ? 'deferred'
                : 'rejected',
            reason: body.reason,
          },
        ];
      const decision = {
        id: 'decision-1',
        decision: body.decision,
        reason: body.reason,
        suggestionId: body.suggestionId ?? null,
        createdAt: '2026-11-03T15:01:00.000Z',
      };
      evaluations.push(decision);
      return json({
        decision,
        duplicate: false,
        order: accepted
          ? { id: 'assistance-order-1', number: '01-CRM', status: 'pendente' }
          : null,
      });
    }
    const detail =
      /^\/api\/v1\/inbox\/conversations\/(assistance-conversation-\d)$/u.exec(
        path,
      );
    if (detail) {
      const conversation = conversations.find((item) => item.id === detail[1]);
      return json({
        conversation,
        messages: [
          {
            ...conversation?.lastMessage,
            text: conversation?.lastMessage.preview,
          },
        ],
        suggestion: null,
      });
    }
    if (/\/conversations\/[^/]+\/order$/u.test(path))
      return json({ order: null });
    if (request.method() !== 'GET')
      writes.push({ path, body: request.postDataJSON() });
    return json({}, 404);
  });
  return { writes, releaseDecision };
}

/** @param {import('@playwright/test').Page} page */
async function openAssistanceDetails(page) {
  await page
    .getByRole('button', { name: 'Detalhes do atendimento', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Pedidos e assuntos', exact: true })
    .click();
  return page.locator('.context-assistance');
}

test('human attendance shows an internal suggestion and creates only after seller action', async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', { name: 'Sugestões de pedido' });
  await expect(region).toContainText(
    'Cliente confirmou o fechamento · 30 camisetas.',
  );
  await expect(region.getByRole('blockquote')).toContainText(
    'Pode fechar as 30 camisetas.',
  );
  expect(writes).toEqual([]);
  const axe = await new AxeBuilder({ page })
    .include('.order-assistance')
    .analyze();
  expect(axe.violations).toEqual([]);
  const create = region.getByRole('button', {
    name: 'Criar pedido',
    exact: true,
  });
  await create.focus();
  await page.keyboard.press('Enter');
  await expect(region).toContainText(
    'Pedido criado com os dados coletados. Ele continua pendente para revisão.',
  );
  await expect(region.getByRole('heading')).toBeFocused();
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({
    suggestionId: 'suggestion-1',
    decision: 'accept',
    reason: 'ready',
    expectedVersion: 1,
    expectedConversationVersion: 7,
    expectedSourceRevision: 4,
  });
  expect(writes[0].csrf).toBe('assistance-csrf');
  expect(writes[0].key).toMatch(/^[a-f0-9-]{36}$/u);
  expect(
    writes.every((write) => write.path.endsWith('/order-assistance/decisions')),
  ).toBe(true);
});

test('a missed confirmation references a customer message without creating an order', async ({
  page,
}) => {
  const { writes } = await setup(page, { empty: true });
  await page.goto('/inbox/assistance-conversation-1');
  await expect(page.locator('.order-assistance')).toBeHidden();
  const region = await openAssistanceDetails(page);
  await region.getByRole('button', { name: 'Já deveria ter sugerido' }).click();
  const evidence = region.getByRole('combobox', {
    name: 'Mensagem em que o cliente confirmou o fechamento',
  });
  await expect(evidence).toBeFocused();
  await evidence.selectOption('assistance-message-1');
  await region.getByRole('button', { name: 'Registrar decisão' }).click();
  await expect(region).toContainText(
    'Omissão registrada para avaliar o agente.',
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toEqual({
    decision: 'missed',
    reason: 'ready',
    sourceMessageId: 'assistance-message-1',
    expectedConversationVersion: 7,
    expectedSourceRevision: 4,
  });
  await region.getByText('Histórico das decisões').click();
  await expect(region).toContainText('Omissão registrada pelo vendedor');
});

test('deferring needs a reason and stale decisions require a fresh review', async ({
  page,
}) => {
  const { writes } = await setup(page, { stale: true });
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', { name: 'Sugestões de pedido' });
  await region.getByRole('button', { name: 'Ainda não' }).click();
  const reason = region.getByRole('combobox', { name: 'Motivo' });
  await expect(reason).toBeFocused();
  await reason.selectOption('not_ready');
  await region.getByRole('button', { name: 'Registrar decisão' }).click();
  await expect(region.getByRole('alert')).toContainText(
    'A conversa ou a sugestão mudou.',
  );
  await expect(region.getByRole('alert')).toBeFocused();
  await region
    .getByRole('button', { name: 'Recolher sugestões de pedido' })
    .click();
  await expect(region.getByRole('alert')).toBeVisible();
  await region
    .getByRole('button', { name: 'Expandir sugestões de pedido' })
    .click();
  await expect(
    region.getByRole('button', { name: 'Criar pedido', exact: true }),
  ).toBeDisabled();
  await region.getByRole('button', { name: 'Atualizar sugestões' }).click();
  await region.getByRole('button', { name: 'Ainda não' }).click();
  await region
    .getByRole('combobox', { name: 'Motivo' })
    .selectOption('not_ready');
  await region.getByRole('button', { name: 'Registrar decisão' }).click();
  await expect(region).toContainText(
    'Sugestão adiada. O motivo foi registrado.',
  );
  expect(writes).toHaveLength(2);
  expect(writes[1].body.expectedVersion).toBe(2);
  expect(writes[1].body.expectedConversationVersion).toBe(8);
});

test('another owner can read the evidence but cannot decide or mark omissions', async ({
  page,
}) => {
  await setup(page, { otherOwner: true });
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', { name: 'Sugestões de pedido' });
  await expect(region).toContainText(
    'O responsável pelo atendimento ou um administrador decide a criação.',
  );
  await expect(
    region.getByRole('button', { name: 'Criar pedido', exact: true }),
  ).toHaveCount(0);
  await expect(
    region.getByRole('button', { name: 'Já deveria ter sugerido' }),
  ).toHaveCount(0);
  await page.goto('/inbox/assistance-conversation-2');
  await expect(page.locator('.order-assistance')).toBeHidden();
  const details = await openAssistanceDetails(page);
  await expect(details).toContainText('Nenhuma sugestão aguardando decisão.');
  await expect(details).not.toContainText('30 camisetas');
});

test('manual creation first requires a conscious purchase confirmation and cancel restores focus', async ({
  page,
}) => {
  const { writes } = await setup(page, { empty: true });
  await page.goto('/inbox/assistance-conversation-1');
  const create = page
    .locator('.conv-actions')
    .getByRole('button', { name: 'Criar pedido', exact: true });
  await create.focus();
  await page.keyboard.press('Enter');
  const confirmation = page.getByRole('dialog', {
    name: 'O cliente confirmou a compra?',
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(
    'Pedir orçamento ou informações não é uma confirmação.',
  );
  expect(writes).toEqual([]);
  expect(
    (await new AxeBuilder({ page }).include('.command-dialog[open]').analyze())
      .violations,
  ).toEqual([]);
  await confirmation
    .getByRole('button', { name: 'Cancelar', exact: true })
    .click();
  await expect(create).toBeFocused();
  await create.click();
  await page.keyboard.press('Escape');
  await expect(confirmation).not.toBeVisible();
  await expect(create).toBeFocused();
  expect(writes).toEqual([]);
});

test('the manager sees measured omissions and manual cases without a false recall claim', async ({
  page,
}) => {
  await mockPainel(page, { manager: true });
  await page.route('**/api/v1/inbox/assistant/performance**', (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route('**/api/v1/inbox/order-assistance/metrics**', (route) =>
    route.fulfill({
      json: {
        days: 7,
        suggestions: 8,
        pending: 1,
        accepted: 4,
        deferred: 2,
        rejected: 1,
        missed: 3,
        manualWithoutSuggestion: 5,
        averageDecisionSeconds: 120,
        averageCreationSeconds: null,
        observations: 40,
        observationFailures: 1,
      },
    }),
  );
  await page.goto('/dashboard/agente');
  const region = page.getByRole('region', {
    name: 'Sugestões de pedido e omissões',
  });
  await expect(
    region
      .getByText('Omissões marcadas pelo vendedor', { exact: true })
      .locator('..')
      .getByRole('definition'),
  ).toHaveText('3');
  await expect(
    region
      .getByText('Pedidos manuais sem sugestão', { exact: true })
      .locator('..')
      .getByRole('definition'),
  ).toHaveText('5');
  await expect(region).toContainText('Sem amostras no período');
  await expect(region).toContainText(
    'não uma contagem de tudo que o agente deixou passar',
  );
  expect(
    (
      await new AxeBuilder({ page })
        .include('.order-assistance-metrics')
        .analyze()
    ).violations,
  ).toEqual([]);
});

test('INBOX-UX-04: collapsing a suggestion retains its reason and keyboard decision', async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', {
    name: 'Sugestões de pedido',
    exact: true,
  });
  const toggle = region.getByRole('button', {
    name: /^(?:Recolher|Expandir) sugestões de pedido$/u,
  });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await region.getByRole('button', { name: 'Ainda não', exact: true }).click();
  await region
    .getByRole('combobox', { name: 'Motivo', exact: true })
    .selectOption('not_ready');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(region.getByRole('combobox')).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(region.getByRole('combobox')).toHaveValue('not_ready');
  await region.getByRole('button', { name: 'Registrar decisão' }).click();
  await expect(region.getByRole('heading')).toBeFocused();
  expect(writes).toHaveLength(1);
  expect(writes[0].body.reason).toBe('not_ready');
});

test('INBOX-UX-04: blocked creation keeps the reason and omission tools in Atendimento', async ({
  page,
}) => {
  const { writes } = await setup(page, { empty: true, blocked: true });
  await page.goto('/inbox/assistance-conversation-1');
  await expect(page.locator('.order-assistance')).toBeHidden();
  const details = await openAssistanceDetails(page);
  await expect(details).toContainText(
    'Já existe um pedido pendente neste atendimento.',
  );
  await expect(
    details.getByRole('button', { name: 'Já deveria ter sugerido' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('list', { name: 'Histórico da conversa' })
      .locator('.order-assistance'),
  ).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('INBOX-UX-04: long suggestions scroll independently on a phone and keep the composer reachable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, { multiple: true });
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', {
    name: 'Sugestões de pedido',
    exact: true,
  });
  await expect(region.locator('.order-assistance-card')).toHaveCount(4);
  const body = region.locator('.order-assistance-body');
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(
    true,
  );
  await expect(page.locator('.inbox-composer textarea')).toBeInViewport();
  await expect(
    page.getByRole('button', { name: 'Já deveria ter sugerido' }),
  ).toBeHidden();
  expect(
    (await new AxeBuilder({ page }).include('.order-assistance').analyze())
      .violations,
  ).toEqual([]);
});

for (const stale of [false, true]) {
  test(`INBOX-UX-04: closing Atendimento during an omission keeps its ${stale ? 'conflict' : 'success'} visible`, async ({
    page,
  }) => {
    const { writes, releaseDecision } = await setup(page, {
      empty: true,
      delayDecision: true,
      stale,
    });
    await page.goto('/inbox/assistance-conversation-1');
    const details = await openAssistanceDetails(page);
    await details
      .getByRole('button', { name: 'Já deveria ter sugerido' })
      .click();
    await details.getByRole('combobox').selectOption('assistance-message-1');
    await details.getByRole('button', { name: 'Registrar decisão' }).click();
    await expect.poll(() => writes.length).toBe(1);
    await page
      .getByRole('button', { name: 'Recolher detalhes', exact: true })
      .click();
    releaseDecision();
    const region = page.getByRole('region', {
      name: 'Sugestões de pedido',
      exact: true,
    });
    await expect(region).toBeVisible();
    if (stale) {
      await expect(region.getByRole('alert')).toContainText(
        'A conversa ou a sugestão mudou.',
      );
      await expect(region.getByRole('alert')).toBeFocused();
    } else {
      await expect(region).toContainText(
        'Omissão registrada para avaliar o agente.',
      );
      await expect(region.getByRole('heading')).toBeFocused();
    }
    await expect(
      page.getByRole('dialog', { name: 'Atendimento', exact: true }),
    ).not.toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0].body.sourceMessageId).toBe('assistance-message-1');
  });
}

test('INBOX-UX-04: a reading error keeps recovery and reply reachable without an empty focus stop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 440 });
  await setup(page, { empty: true });
  await page.route('**/order-assistance', (route) =>
    route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE' } } }),
  );
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', {
    name: 'Sugestões de pedido',
    exact: true,
  });
  await expect(region.getByRole('alert')).toContainText(
    'Não foi possível consultar as sugestões de pedido.',
  );
  await expect(region.locator('.order-assistance-body')).toBeHidden();
  await expect(region.locator('.order-assistance-body')).not.toHaveAttribute(
    'tabindex',
    '0',
  );
  const retry = region.getByRole('button', { name: 'Atualizar sugestões' });
  await retry.focus();
  await expect(retry).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.inbox-composer textarea')).toBeInViewport({
    ratio: 1,
  });
  expect(
    (await new AxeBuilder({ page }).include('.order-assistance').analyze())
      .violations,
  ).toEqual([]);
});

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
]) {
  test(`INBOX-UX-04: an ordinary suggestion exposes all decisions without scrolling at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await page.goto('/inbox/assistance-conversation-1');
    const region = page.getByRole('region', {
      name: 'Sugestões de pedido',
      exact: true,
    });
    await expect(region).toContainText(
      'Ao criar, você confirma que o cliente decidiu fechar. O pedido nasce pendente.',
    );
    await expect(region.getByRole('blockquote')).toContainText(
      'Pode fechar as 30 camisetas.',
    );
    await expect(region.locator('time')).toHaveAttribute(
      'datetime',
      '2026-11-03T15:00:01.000Z',
    );
    await expect(region.locator('.order-assistance-body')).toHaveJSProperty(
      'scrollTop',
      0,
    );
    for (const name of ['Criar pedido', 'Ainda não', 'Não vai seguir'])
      await expect(
        region.getByRole('button', { name, exact: true }),
      ).toBeInViewport({ ratio: 1 });
    if (viewport.width > 768)
      expect((await region.boundingBox())?.height).toBeLessThanOrEqual(190);
    await expect(page.locator('.inbox-composer textarea')).toBeInViewport({
      ratio: 1,
    });
  });
}
