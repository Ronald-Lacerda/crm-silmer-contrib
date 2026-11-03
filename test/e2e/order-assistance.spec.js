import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockPainel } from './support/painel-mock.js';

// OA-01..12: fictional conversations only. This feature must never send a
// message to the customer; every write is inspected below.

/** @param {import('@playwright/test').Page} page
 * @param {{empty?: boolean, otherOwner?: boolean, stale?: boolean}} [options]
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
  /** @type {any[]} */
  const evaluations = [];
  /** @type {{path:string,body:any,csrf?:string,key?:string}[]} */
  const writes = [];
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
  return { writes };
}

test('human attendance shows an internal suggestion and creates only after seller action', async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto('/inbox/assistance-conversation-1');
  const region = page.getByRole('region', { name: 'Sugestões de pedido' });
  await expect(region).toContainText(
    'Cliente confirmou que quer fechar 30 camisetas. Criar pedido?',
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
  const region = page.getByRole('region', { name: 'Sugestões de pedido' });
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
  await expect(region).toContainText('Nenhuma sugestão aguardando decisão.');
  await expect(region).not.toContainText('30 camisetas');
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
