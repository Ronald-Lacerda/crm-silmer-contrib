import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// INBOX-AUDIO-TRANSCRIPT-01 (RFC 041): the seller reads what the automatic
// transcription heard, under the customer's audio. Synthetic text only.
const SHORT = 'Oi, queria 30 camisetas pretas para o time.';
const LONG = `${'Quero fazer camisetas para a minha equipe de corrida, '.repeat(8)}e também bonés no mesmo tom.`;

/** @param {string} id @param {Record<string, unknown>|null} transcript */
function audio(id, transcript) {
  return {
    authorId: 'contact-1',
    authorKind: 'contact',
    createdAt: '2026-10-30T12:00:00.000Z',
    deliveryErrorCode: null,
    deliveryStatus: null,
    direction: 'inbound',
    id,
    media: {
      contentUrl: `/api/v1/conversations/conversation-1/media/${id}/content`,
      durationMs: 12_000,
      kind: 'audio',
      mediaId: `media-${id}`,
      mimeType: 'audio/ogg',
      sizeBytes: 2048,
      state: 'attached',
    },
    occurredAt: '2026-10-30T12:00:00.000Z',
    preview: 'Áudio',
    status: 'received',
    type: 'audio',
    ...(transcript ? { transcript } : {}),
  };
}

/** @param {import('@playwright/test').Page} page */
async function setup(page) {
  const conversation = {
    id: 'conversation-1',
    version: 3,
    channel: 'whatsapp',
    state: 'em_atendimento',
    automationState: 'human',
    automationEpoch: 2,
    assignedUser: { id: 'seller-1', functionName: 'Vendedor' },
    handoff: null,
    contact: {
      id: 'contact-1',
      label: 'Cliente sintético',
      externalId: '5500000000000',
    },
    lastMessage: {
      id: 'audio-long',
      type: 'audio',
      preview: 'Áudio',
      direction: 'inbound',
    },
    requiresAttention: false,
  };
  const messages = [
    audio('audio-short', { status: 'ok', text: SHORT }),
    audio('audio-failed', { status: 'failed', text: null }),
    audio('audio-pending', null),
    audio('audio-long', { status: 'ok', text: LONG }),
  ];
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
}

test('shows the automatic transcript under each audio, full and selectable', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/inbox/conversation-1');
  const thread = page.getByRole('list', { name: 'Histórico da conversa' });
  const short = thread.getByRole('listitem').nth(0);
  await expect(short).toContainText('Transcrição automática');
  await expect(short).toContainText(SHORT);
  const userSelect = await short
    .locator('.message-transcript__text')
    .evaluate((element) => globalThis.getComputedStyle(element).userSelect);
  expect(userSelect).not.toBe('none');

  // A failed transcription is a quiet note, not an alert.
  const failed = thread.getByRole('listitem').nth(1);
  await expect(failed).toContainText(
    'Não foi possível transcrever este áudio. Ouça a gravação.',
  );
  await expect(failed.getByRole('alert')).toHaveCount(0);
  // Without a transcript (older API or still transcribing) nothing appears.
  await expect(thread.getByRole('listitem').nth(2)).not.toContainText(
    'Transcrição',
  );

  // A long transcript opens in place by keyboard; nothing is lost.
  const long = thread.getByRole('listitem').nth(3);
  await expect(long).not.toContainText(LONG);
  await expect(long).toContainText('…');
  const more = long.getByRole('button', { name: 'Ler transcrição completa' });
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(long).toContainText(LONG);
  const less = long.getByRole('button', { name: 'Mostrar menos' });
  await expect(less).toHaveAttribute('aria-expanded', 'true');
  await expect(less).toBeFocused();
  await page.keyboard.press('Space');
  await expect(
    long.getByRole('button', { name: 'Ler transcrição completa' }),
  ).toBeFocused();

  // The customer's words never reach the address or browser storage.
  expect(page.url()).not.toContain('camisetas');
  const stored = await page.evaluate(() =>
    JSON.stringify({
      ...globalThis.localStorage,
      ...globalThis.sessionStorage,
    }),
  );
  expect(stored).not.toContain('camisetas');

  // Scoped to the transcripts: several audios in one thread repeat the
  // "Mídia da mensagem" region of MediaMessage (a finding of its own).
  const axe = await new AxeBuilder({ page })
    .include('.message-transcript')
    .analyze();
  expect(axe.violations).toEqual([]);
});
