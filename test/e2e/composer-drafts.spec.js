import { expect, test } from '@playwright/test';
import { mockConversationShipping } from './support/conversation-shipping-mock.js';

// UX-FUNC-01 / PCX-13, MSG-02/03: the reply belongs to its customer, including
// when a send finishes after the seller has moved to another conversation.
const FIRST = 'shipping-conversation-1';
const SECOND = 'shipping-conversation-2';
const FIRST_DRAFT = 'Resposta sintética exclusiva para o cliente 1';
const SECOND_DRAFT = 'Resposta sintética exclusiva para o cliente 2';

/** @param {import('@playwright/test').Page} page @param {string} id */
async function openConversation(page, id) {
  const back = page.getByRole('link', { exact: true, name: 'Conversas' });
  if (await back.isVisible()) await back.click();
  await page.locator(`[data-conversation-id="${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${id}$`, 'u'));
  await expect(page.getByLabel('Responder', { exact: true })).toBeVisible();
}

for (const phone of [false, true]) {
  test.describe(phone ? 'phone reply drafts' : 'desktop reply drafts', () => {
    test.use(
      phone
        ? { hasTouch: true, viewport: { height: 844, width: 390 } }
        : { viewport: { height: 768, width: 1366 } },
    );

    test('keeps each draft with its conversation and discards it on reload', async ({
      page,
    }) => {
      await mockConversationShipping(page);
      await page.goto(`/inbox/${FIRST}`);
      const reply = page.getByLabel('Responder', { exact: true });
      await reply.fill(FIRST_DRAFT);
      await openConversation(page, SECOND);
      await expect(reply).toHaveValue('');
      await reply.fill(SECOND_DRAFT);
      await openConversation(page, FIRST);
      await expect(reply).toHaveValue(FIRST_DRAFT);
      await openConversation(page, SECOND);
      await expect(reply).toHaveValue(SECOND_DRAFT);
      await page.reload();
      await expect(reply).toHaveValue('');
    });
  });
}

test.describe('reply command outcomes', () => {
  test.use({ viewport: { height: 768, width: 1366 } });

  test('keeps a failed reply and clears it only when accepted for sending', async ({
    page,
  }) => {
    await mockConversationShipping(page);
    let available = false;
    /** @type {any[]} */
    const sends = [];
    await page.route(
      `**/api/v1/conversations/${FIRST}/messages`,
      async (route) => {
        sends.push(route.request().postDataJSON());
        expect(route.request().headers()['idempotency-key']).toBeTruthy();
        await route.fulfill({
          json: available ? {} : { code: 'UNAVAILABLE' },
          status: available ? 200 : 503,
        });
      },
    );
    await page.goto(`/inbox/${FIRST}`);
    const reply = page.getByLabel('Responder', { exact: true });
    await reply.fill(FIRST_DRAFT);
    await page
      .getByRole('button', { name: 'Enviar resposta', exact: true })
      .click();
    await expect(page.getByRole('alert')).toHaveText(
      'Serviço indisponível no momento.',
    );
    await expect(reply).toHaveValue(FIRST_DRAFT);
    available = true;
    await page
      .getByRole('button', { name: 'Enviar resposta', exact: true })
      .click();
    await expect(
      page.getByText('Mensagem aceita para envio.', { exact: true }),
    ).toBeVisible();
    await expect(reply).toHaveValue('');
    await expect(reply).toBeFocused();
    expect(sends).toHaveLength(2);
    expect(sends[1].content.text).toBe(FIRST_DRAFT);
  });

  for (const status of [200, 503]) {
    test(`a delayed ${status} reply cannot replace the next customer's draft or feedback`, async ({
      page,
    }) => {
      await mockConversationShipping(page);
      /** @type {() => void} */
      let finish = () => {};
      const finished = new Promise((resolve) => {
        finish = () => resolve(undefined);
      });
      /** @type {() => void} */
      let started = () => {};
      const sending = new Promise((resolve) => {
        started = () => resolve(undefined);
      });
      await page.route(
        `**/api/v1/conversations/${FIRST}/messages`,
        async (route) => {
          expect(route.request().postDataJSON().content.text).toBe(FIRST_DRAFT);
          started();
          await finished;
          await route.fulfill({
            json: status === 200 ? {} : { code: 'UNAVAILABLE' },
            status,
          });
        },
      );
      await page.goto(`/inbox/${SECOND}`);
      const reply = page.getByLabel('Responder', { exact: true });
      await reply.fill(SECOND_DRAFT);
      await openConversation(page, FIRST);
      await reply.fill(FIRST_DRAFT);
      await page
        .getByRole('button', { name: 'Enviar resposta', exact: true })
        .click();
      await sending;
      try {
        await openConversation(page, SECOND);
        const response = page.waitForResponse((answer) =>
          answer.url().endsWith(`/conversations/${FIRST}/messages`),
        );
        finish();
        await response;
        await expect(reply).toBeEnabled();
        await expect(reply).toHaveValue(SECOND_DRAFT);
        await expect(
          page.getByText('Mensagem aceita para envio.', { exact: true }),
        ).toHaveCount(0);
        await expect(
          page.getByText('Serviço indisponível no momento.', { exact: true }),
        ).toHaveCount(0);
        await openConversation(page, FIRST);
        await expect(reply).toHaveValue(status === 200 ? '' : FIRST_DRAFT);
      } finally {
        finish();
      }
    });
  }
});
