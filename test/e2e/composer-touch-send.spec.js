import { expect, test } from '@playwright/test';
import { mockConversationShipping } from './support/conversation-shipping-mock.js';

// COB-REV-01 / MSG-02/03 / PCX-13 / UX-FUNC-01: moving focus from a reply
// to its send button must not move that button out from under a real tap.
const CONVERSATION = 'shipping-conversation-1';
const PAYMENT_LINK = 'https://checkout.infinitepay.io/synthetic-checkout';
const PLAIN_TEXT = 'Resposta sintética para o cliente';

/** @param {import('@playwright/test').Page} page */
async function setup(page) {
  await mockConversationShipping(page);
  let available = true;
  /** @type {Array<{body: any, key: string|undefined}>} */
  const sends = [];
  await page.route(
    `**/api/v1/conversations/${CONVERSATION}/messages`,
    async (route) => {
      const request = route.request();
      sends.push({
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
      await route.fulfill({
        json: available ? {} : { code: 'UNAVAILABLE' },
        status: available ? 200 : 503,
      });
    },
  );
  await page.goto(`/inbox/${CONVERSATION}`);
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  const send = page.getByRole('button', {
    name: 'Enviar resposta',
    exact: true,
  });
  await expect(reply).toBeEnabled();
  return {
    reply,
    send,
    sends,
    fail() {
      available = false;
    },
    recover() {
      available = true;
    },
  };
}

for (const width of [390, 320]) {
  test.describe(`touch reply at ${width}px`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 844 } });

    for (const [kind, text] of [
      ['payment link', PAYMENT_LINK],
      ['ordinary text', PLAIN_TEXT],
    ]) {
      test(`one tap sends ${kind} once after typing`, async ({ page }) => {
        const { reply, send, sends } = await setup(page);
        await expect(send).toBeDisabled();
        await reply.fill(text);
        await expect(reply).toBeFocused();
        await send.tap();
        await expect(
          page.getByText('Mensagem aceita para envio.', { exact: true }),
        ).toBeVisible();
        await expect(reply).toHaveValue('');
        await expect(reply).toBeFocused();
        await expect(send).toBeDisabled();
        expect(sends).toHaveLength(1);
        expect(sends[0].key).toBeTruthy();
        expect(sends[0].body.content.text).toBe(text);
      });
    }
  });
}

test.describe('touch reply failure and keyboard recovery', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('keeps the failed draft and lets the keyboard retry explicitly', async ({
    page,
  }) => {
    const { reply, send, sends, fail, recover } = await setup(page);
    fail();
    await reply.fill(PAYMENT_LINK);
    await send.tap();
    await expect(page.getByRole('alert')).toHaveText(
      'Serviço indisponível no momento.',
    );
    await expect(reply).toHaveValue(PAYMENT_LINK);
    expect(sends).toHaveLength(1);
    recover();
    await send.focus();
    await page.keyboard.press('Enter');
    await expect(reply).toHaveValue('');
    await expect(reply).toBeFocused();
    expect(sends).toHaveLength(2);
    for (const sent of sends) {
      expect(sent.key).toBeTruthy();
      expect(sent.body.content.text).toBe(PAYMENT_LINK);
    }
  });
});

test.describe('desktop reply', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('one click sends the payment link once', async ({ page }) => {
    const { reply, send, sends } = await setup(page);
    await reply.fill(PAYMENT_LINK);
    await send.click();
    await expect(reply).toHaveValue('');
    await expect(reply).toBeFocused();
    expect(sends).toHaveLength(1);
    expect(sends[0].key).toBeTruthy();
    expect(sends[0].body.content.text).toBe(PAYMENT_LINK);
  });
});
