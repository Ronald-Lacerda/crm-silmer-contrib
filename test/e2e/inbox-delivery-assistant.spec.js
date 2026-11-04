import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// INBOX-DELIVERY-02 (RFC 041): the agent's failed or uncertain replies show
// their own code for support, explained in plain words. Synthetic data.

/** @param {string} id @param {string} deliveryStatus @param {string|null} code */
function assistantReply(id, deliveryStatus, code) {
  return {
    authorId: 'AUTOMATION_EXECUTOR',
    authorKind: 'assistant',
    createdAt: '2026-10-30T12:00:00.000Z',
    deliveryErrorCode: code,
    deliveryMode: 'official',
    deliveryStatus,
    direction: 'outbound',
    id,
    media: null,
    occurredAt: '2026-10-30T12:00:00.000Z',
    preview: 'Mensagem sintética do agente.',
    status: deliveryStatus,
    type: 'text',
  };
}

/** @param {import('@playwright/test').Page} page
 * @param {ReturnType<typeof assistantReply>[]} [messages]
 */
async function setup(
  page,
  messages = [
    assistantReply('reply-failed', 'failed', 'SEND_FAILED'),
    assistantReply('reply-unknown', 'outcome_unknown', 'SEND_OUTCOME_UNKNOWN'),
  ],
) {
  const conversation = {
    id: 'conversation-1',
    version: 3,
    channel: 'whatsapp',
    state: 'em_atendimento',
    automationState: 'assistant',
    automationEpoch: 2,
    assignedUser: null,
    handoff: null,
    contact: {
      id: 'contact-1',
      label: 'Cliente sintético',
      externalId: '5500000000000',
    },
    lastMessage: {
      id: 'reply-unknown',
      type: 'text',
      preview: 'Mensagem sintética do agente.',
      direction: 'outbound',
    },
    requiresAttention: true,
  };
  /** @type {string[]} */
  const writes = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') writes.push(request.url());
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
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
        json: { items: [conversation], totalCount: 1, nextCursor: null },
      });
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
    if (path === '/api/v1/inbox/conversations/conversation-1')
      return route.fulfill({
        json: { conversation, messages, suggestion: null },
      });
    return route.fulfill({ status: 404, json: {} });
  });
  return { writes };
}

test('the agent reply that failed shows its code and what it means', async ({
  page,
}) => {
  const { writes } = await setup(page);
  await page.goto('/inbox/conversation-1');
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  const failed = thread.getByRole('listitem').nth(0);
  await expect(failed).toContainText('A resposta do agente não foi enviada');
  await expect(failed).toContainText(
    'O cliente pode não ter recebido esta resposta do agente.',
  );
  await expect(failed.getByText('SEND_FAILED')).toBeHidden();
  await failed
    .getByText('Detalhes para suporte', { exact: true })
    .press('Enter');
  await expect(failed.getByText('SEND_FAILED', { exact: true })).toBeVisible();
  await expect(failed).toContainText(
    'O serviço de mensagens não entregou a mensagem ao cliente.',
  );
  await expect(failed.getByText('reply-failed', { exact: true })).toBeVisible();

  const unknown = thread.getByRole('listitem').nth(1);
  await expect(unknown).toContainText(
    'Ainda não conseguimos confirmar o envio',
  );
  await expect(unknown).toContainText(
    'A confirmação desta resposta do agente está demorando.',
  );
  await unknown
    .getByText('Detalhes para suporte', { exact: true })
    .press('Enter');
  await expect(
    unknown.getByText('SEND_OUTCOME_UNKNOWN', { exact: true }),
  ).toBeVisible();
  await expect(unknown).toContainText(
    'O serviço de mensagens não confirmou se a mensagem chegou ao cliente.',
  );
  // Reading the details never sends anything again.
  expect(writes).toEqual([]);
  const axe = await new AxeBuilder({ page })
    .include('.message-delivery-notice')
    .analyze();
  expect(axe.violations).toEqual([]);
});

test('known recipient failures explain the next step and keep uncertain sends uncertain', async ({
  page,
}) => {
  const { writes } = await setup(page, [
    {
      ...assistantReply(
        'recipient-missing',
        'failed',
        'EVOLUTION_RECIPIENT_NOT_FOUND',
      ),
      authorKind: 'human',
      authorId: 'seller-1',
    },
    {
      ...assistantReply(
        'recipient-unavailable',
        'failed',
        'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE',
      ),
      authorKind: 'human',
      authorId: 'seller-1',
    },
    {
      ...assistantReply(
        'recipient-unknown',
        'outcome_unknown',
        'EVOLUTION_RECIPIENT_NOT_FOUND',
      ),
      authorKind: 'human',
      authorId: 'seller-1',
    },
  ]);
  await page.goto('/inbox/conversation-1');
  const items = page
    .getByRole('list', { name: 'Histórico da conversa' })
    .getByRole('listitem');
  const missing = items.nth(0);
  await expect(missing).toContainText('WhatsApp não reconheceu este número');
  await expect(missing).toContainText(
    'A mensagem não foi enviada. Confira o telefone do cliente antes de enviar outra mensagem.',
  );
  await missing
    .getByText('Detalhes para suporte', { exact: true })
    .press('Enter');
  await expect(
    missing.getByText('EVOLUTION_RECIPIENT_NOT_FOUND', { exact: true }),
  ).toBeVisible();
  const unavailable = items.nth(1);
  await expect(unavailable).toContainText(
    'Não foi possível verificar o número no WhatsApp',
  );
  await expect(unavailable).toContainText(
    'A mensagem não foi enviada porque a verificação do número não pôde ser concluída.',
  );
  const uncertain = items.nth(2);
  await expect(uncertain).toContainText(
    'Ainda não conseguimos confirmar o envio',
  );
  await expect(uncertain).toContainText(
    'Verifique o envio antes de repetir a mensagem para evitar duplicidade.',
  );
  await expect(uncertain).not.toContainText('A mensagem não foi enviada.');
  expect(writes).toEqual([]);
  const axe = await new AxeBuilder({ page })
    .include('.message-delivery-notice')
    .analyze();
  expect(axe.violations).toEqual([]);
});
