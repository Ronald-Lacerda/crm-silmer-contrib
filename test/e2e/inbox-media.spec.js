import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';

/**
 * Mirrors the API: in tab mode every returned item carries the requested
 * `bucket`; the front rejects lists that omit it (stale API protection).
 * @param {any[]} items
 * @param {string} requestUrl
 */
function withBucket(items, requestUrl) {
  const bucket = new URL(requestUrl).searchParams.get('bucket');
  return bucket ? items.map((item) => ({ ...item, bucket })) : items;
}

/** @param {import('@playwright/test').Page} page @param {any} [options] */
async function setup(page, options = {}) {
  const conversations = [1, 2].map((number) => ({
    id: `conversation-${number}`,
    version: 4,
    channel: 'whatsapp',
    state: 'em_atendimento',
    automationState: 'human',
    automationEpoch: 2,
    assignedUser: { id: 'seller-1', functionName: 'Vendedor' },
    ...(options.receivedImage
      ? {
          order: {
            id: `order-${number}`,
            number: `0${number}-CRM`,
            status: options.orderStatus ?? 'pendente',
          },
        }
      : {}),
    handoff: null,
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
  }));
  if (options.otherOwner) conversations[0].assignedUser.id = 'seller-2';
  const messages = new Map(
    conversations.map((conversation) => [
      conversation.id,
      [conversation.lastMessage],
    ]),
  );
  if (options.receivedImage) {
    messages.get('conversation-1')?.push(
      /** @type {any} */ ({
        id: 'received-image',
        type: 'image',
        preview: 'Imagem',
        direction: options.direction ?? 'inbound',
        occurredAt: '2026-10-29T10:00:00Z',
        media: options.missingMedia
          ? null
          : {
              mediaId: 'media-inbound',
              kind: 'image',
              state: 'attached',
              contentUrl:
                '/api/v1/conversations/conversation-1/media/media-inbound/content',
            },
      }),
    );
  }
  const orderUploads = /** @type {import('@playwright/test').Request[]} */ ([]);
  const uploads = /** @type {import('@playwright/test').Request[]} */ ([]);
  const sends = /** @type {import('@playwright/test').Request[]} */ ([]);
  /** @type {import('@playwright/test').Route | null} */ let eventRoute = null;
  /** @type {import('@playwright/test').Route | null} */ let uploadRoute = null;
  /** @type {import('@playwright/test').Route | null} */ let sendRoute = null;
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 'csrf-media', url: 'http://127.0.0.1:4173' },
    ]);
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path === '/api/v1/sessions/current')
      return route.fulfill({
        json: {
          user: { id: 'seller-1', functionName: 'Vendedor', capabilities: [] },
        },
      });
    if (path === '/api/v1/events') {
      eventRoute = route;
      return;
    }
    if (
      path ===
      '/api/v1/conversations/conversation-1/media/media-inbound/content'
    ) {
      return route.fulfill({
        contentType: 'image/png',
        body: await readFile('test/fixtures/media-composer.png'),
      });
    }
    if (/^\/api\/v1\/orders\/order-[12]\/files$/.test(path)) {
      orderUploads.push(request);
      return route.fulfill({
        json: { references: [{ id: 'reference-one' }], final: null },
      });
    }
    if (path === '/api/v1/users/assignable')
      return route.fulfill({
        json: {
          users: [
            { id: 'seller-1', name: 'Vendedor sintético' },
            { id: 'seller-2', name: 'Outro vendedor' },
          ],
        },
      });
    if (path === '/api/v1/inbox/conversations')
      return route.fulfill({
        json: {
          items: withBucket(conversations, route.request().url()),
          totalCount: 2,
          nextCursor: null,
        },
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
    const detail = /^\/api\/v1\/inbox\/conversations\/([^/]+)$/.exec(path);
    if (detail)
      return route.fulfill({
        json: {
          conversation: conversations.find((item) => item.id === detail[1]),
          messages: messages.get(detail[1]),
          suggestion: null,
        },
      });
    const match =
      /^\/api\/v1\/conversations\/([^/]+)\/(media|messages)(?:\/(.*))?$/.exec(
        path,
      );
    if (match?.[2] === 'media' && request.method() === 'POST') {
      uploads.push(request);
      if (options.pendingUpload) {
        uploadRoute = route;
        return;
      }
      return route.fulfill({
        status: 202,
        json: { mediaId: `media-${match[1]}`, state: 'processing' },
      });
    }
    if (match?.[2] === 'media')
      return route.fulfill({
        json: {
          mediaId: `media-${match[1]}`,
          state: options.processing ? 'processing' : 'ready',
        },
      });
    if (match?.[2] === 'messages') {
      sends.push(request);
      if (options.pendingSend) {
        sendRoute = route;
        return;
      }
      const body = request.postDataJSON();
      messages.get(match[1])?.push(
        /** @type {any} */ ({
          id: `sent-${sends.length}`,
          type: body.messageType,
          preview:
            body.content.text || body.content.caption || 'Anexo sintético',
          direction: 'outbound',
          authorKind: 'human',
          authorId: 'seller-1',
          deliveryStatus: 'sent',
          deliveryMode: 'dev',
          occurredAt: '2026-10-06T10:00:00Z',
          media:
            body.messageType === 'text'
              ? null
              : {
                  mediaId: body.content.mediaId,
                  kind: body.messageType,
                  state: 'lost',
                  contentUrl: null,
                },
        }),
      );
      return route.fulfill({
        status: 202,
        json: { id: `sent-${sends.length}` },
      });
    }
    return route.fulfill({ json: { items: [], users: [], order: null } });
  });
  await page.goto('/inbox');
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toBeVisible();
  return {
    uploads,
    orderUploads,
    sends,
    conversations,
    async sse(changed = true) {
      await expect.poll(() => Boolean(eventRoute)).toBe(true);
      await eventRoute?.fulfill({
        contentType: 'text/event-stream',
        body: changed
          ? 'retry: 60000\n\nevent: inbox.conversation.changed\nid: synthetic-1\ndata: {"type":"inbox.conversation.changed","conversationId":"conversation-1"}\n\n'
          : 'retry: 60000\n\n: connected\n\n',
      });
    },
    async releaseUpload() {
      await uploadRoute?.fulfill({
        status: 202,
        json: { mediaId: 'old-media', state: 'processing' },
      });
    },
    async releaseSend() {
      await sendRoute?.fulfill({
        status: 202,
        json: { id: 'pending-media-send' },
      });
    },
  };
}

test('IMG-01/ARQ-02 Inbox owner attaches a received image to the explicitly selected pending order', async ({
  page,
}) => {
  const state = await setup(page, { receivedImage: true });
  const image = page.getByRole('img', { name: 'Imagem da conversa' });
  await expect(image).toBeVisible();
  await page
    .getByRole('button', { name: 'Anexar imagem ao pedido', exact: true })
    .click();
  await page
    .getByRole('combobox', { name: 'Anexar imagem ao pedido' })
    .selectOption('order-1');
  const attach = page.getByRole('button', {
    name: 'Anexar ao pedido',
    exact: true,
  });
  await attach.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Imagem anexada ao pedido 01-CRM.', { exact: true }),
  ).toBeVisible();
  expect(state.orderUploads).toHaveLength(1);
  expect(new URL(state.orderUploads[0].url()).pathname).toBe(
    '/api/v1/orders/order-1/files',
  );
  expect(state.orderUploads[0].headers()['x-csrf-token']).toBe('csrf-media');
  expect(state.sends).toHaveLength(0);
});

test('IMG-08 received image without attachment announces unavailable bytes', async ({
  page,
}) => {
  const state = await setup(page, { receivedImage: true, missingMedia: true });
  await expect(
    page.getByText(
      'Imagem recebida sem arquivo disponível. O histórico foi preservado.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Anexar imagem ao pedido' }),
  ).toHaveCount(0);
  expect(state.orderUploads).toHaveLength(0);
  expect(state.sends).toHaveLength(0);
});

for (const options of [
  { otherOwner: true },
  { orderStatus: 'confirmado' },
  { direction: 'outbound' },
]) {
  test(`IMG-02 Inbox does not offer attach for ${JSON.stringify(options)}`, async ({
    page,
  }) => {
    const state = await setup(page, { receivedImage: true, ...options });
    await expect(
      page.getByRole('img', { name: 'Imagem da conversa' }),
    ).toBeVisible();
    await expect(
      page.getByRole('combobox', { name: 'Anexar imagem ao pedido' }),
    ).toHaveCount(0);
    expect(state.orderUploads).toHaveLength(0);
  });
}

/** @param {import('@playwright/test').Page} page */
async function fakeMicrophone(page) {
  await page.addInitScript(() => {
    const evidence = { stops: 0 };
    /** @type {any} */ (globalThis).__mic = evidence;
    globalThis.navigator.mediaDevices.getUserMedia = async () =>
      /** @type {any} */ ({
        getTracks: () => [{ stop: () => evidence.stops++ }],
      });
    class Recorder extends globalThis.EventTarget {
      static isTypeSupported() {
        return true;
      }
      mimeType = 'audio/ogg;codecs=opus';
      state = 'inactive';
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        globalThis.queueMicrotask(() => {
          this.dispatchEvent(
            new globalThis.MessageEvent('dataavailable', {
              data: new globalThis.Blob([new Uint8Array(128)], {
                type: this.mimeType,
              }),
            }),
          );
          this.dispatchEvent(new globalThis.Event('stop'));
        });
      }
    }
    /** @type {any} */ (globalThis).MediaRecorder = Recorder;
  });
}

for (const [kind, fixture] of [
  ['image', 'png'],
  ['audio', 'm4a'],
  ['video', 'mp4'],
]) {
  test(`MED-01..03/08 ${kind} explicit send binds selected conversation and shows DEV`, async ({
    page,
  }) => {
    const state = await setup(page);
    await page
      .getByLabel('Arquivo para anexar')
      .setInputFiles(`test/fixtures/media-composer.${fixture}`);
    await expect.poll(() => state.uploads.length).toBe(1);
    await expect(
      page.getByRole('button', { name: 'Enviar anexo', exact: true }),
    ).toBeEnabled();
    expect(state.sends).toHaveLength(0);
    await page
      .getByRole('button', { name: 'Enviar anexo', exact: true })
      .click();
    await expect(
      page.getByText('DEV: envio simulado', { exact: true }),
    ).toBeVisible();
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0].url()).toContain(
      '/conversations/conversation-1/messages',
    );
    expect(state.sends[0].postDataJSON()).toMatchObject({
      expectedVersion: 4,
      messageType: kind,
      content: { mediaId: 'media-conversation-1' },
    });
    expect(state.sends[0].headers()['x-csrf-token']).toBe('csrf-media');
    expect(state.sends[0].headers()['idempotency-key']).toBeTruthy();
  });
}

test('MED-08 other owner disables attachments and microphone while preserving history', async ({
  page,
}) => {
  await setup(page, { otherOwner: true });
  await expect(page.getByLabel('Arquivo para anexar')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Gravar áudio', exact: true }),
  ).toBeDisabled();
  await expect(page.getByText('Mensagem inicial').last()).toBeVisible();
});

test('MED-08/13 switch during pending upload removes draft and ignores late result', async ({
  page,
}) => {
  const state = await setup(page, { pendingUpload: true });
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await expect.poll(() => state.uploads.length).toBe(1);
  await page.getByRole('button', { name: /Cliente sintético 2/ }).click();
  await state.releaseUpload();
  await expect(
    page.getByRole('heading', { name: 'Cliente sintético 2' }),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: 'Prévia do anexo' })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toHaveCount(0);
  expect(state.sends).toHaveLength(0);
});

for (const transition of ['close', 'transfer']) {
  test(`MED-08 ${transition} SSE invalidates processing draft and blocks stale send`, async ({
    page,
  }) => {
    const state = await setup(page, { processing: true });
    await page
      .getByLabel('Arquivo para anexar')
      .setInputFiles('test/fixtures/media-composer.png');
    await expect(
      page.getByText('Validando arquivo…', { exact: true }),
    ).toBeVisible();
    state.conversations[0].version = 5;
    if (transition === 'close') state.conversations[0].state = 'sem_lead';
    else state.conversations[0].assignedUser.id = 'seller-2';
    await state.sse();
    await expect(page.getByLabel('Arquivo para anexar')).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Enviar anexo', exact: true }),
    ).toHaveCount(0);
    expect(state.sends).toHaveLength(0);
  });
}

test('MED-13 switching active capture stops microphone without send', async ({
  page,
}) => {
  await fakeMicrophone(page);
  const state = await setup(page);
  await page.getByRole('button', { name: 'Gravar áudio', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Parar gravação' }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Cliente sintético 2/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => /** @type {any} */ (globalThis).__mic.stops),
    )
    .toBe(1);
  await expect(
    page.getByRole('button', { name: 'Parar gravação' }),
  ).toHaveCount(0);
  expect(state.uploads).toHaveLength(0);
  expect(state.sends).toHaveLength(0);
});

test('MED-10/13 recording review replaced by attachment has no stale discard or status', async ({
  page,
}) => {
  await fakeMicrophone(page);
  const state = await setup(page);
  await page.getByRole('button', { name: 'Gravar áudio', exact: true }).click();
  await page.getByRole('button', { name: 'Parar gravação' }).click();
  await expect(page.getByLabel('Prévia do áudio')).toBeVisible();
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Descartar gravação' }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Ouça a gravação e envie quando quiser.', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Remover anexo' }).click();
  await expect(
    page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
  ).toBeFocused();
  expect(state.sends).toHaveLength(0);
});

test('MED-25 text remains available and accepted media restores focus without axe violations', async ({
  page,
}) => {
  const state = await setup(page);
  await page
    .getByRole('textbox', { name: 'Responder', exact: true })
    .fill('Texto sintético');
  await page
    .getByRole('button', { name: 'Enviar resposta', exact: true })
    .click();
  await expect(
    page.getByRole('textbox', { name: 'Responder', exact: true }),
  ).toBeFocused();
  expect(state.sends[0].postDataJSON()).toMatchObject({
    messageType: 'text',
    content: { text: 'Texto sintético' },
  });
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
  ).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('MED-08 stale detail response cannot replace newly selected conversation', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (input, options) => {
      if (
        String(input).endsWith('/inbox/conversations/conversation-1') &&
        ++calls === 2
      ) {
        const response = await original(input, {
          ...options,
          signal: undefined,
        });
        const body = await response.text();
        await new Promise((resolve) => {
          /** @type {any} */ (globalThis).__releaseOldDetail = resolve;
        });
        return new globalThis.Response(body, {
          status: response.status,
          headers: response.headers,
        });
      }
      return original(input, options);
    };
  });
  const state = await setup(page);
  await state.sse(false);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean(/** @type {any} */ (globalThis).__releaseOldDetail),
      ),
    )
    .toBe(true);
  await page.getByRole('button', { name: /Cliente sintético 2/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Cliente sintético 2' }),
  ).toBeVisible();
  await page.evaluate(async () => {
    /** @type {any} */ (globalThis).__releaseOldDetail();
    await new Promise((resolve) =>
      globalThis.requestAnimationFrame(() =>
        globalThis.requestAnimationFrame(resolve),
      ),
    );
  });
  await expect(
    page.getByRole('heading', { name: 'Cliente sintético 2' }),
  ).toBeVisible();
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await expect.poll(() => state.uploads.length).toBe(1);
  expect(state.uploads[0].url()).toContain(
    '/conversations/conversation-2/media',
  );
});

test('MED-01/10 replacing reviewed recording sends selected image as attachment', async ({
  page,
}) => {
  await fakeMicrophone(page);
  const state = await setup(page);
  await page.getByRole('button', { name: 'Gravar áudio', exact: true }).click();
  await page.getByRole('button', { name: 'Parar gravação' }).click();
  await expect(page.getByLabel('Prévia do áudio')).toBeVisible();
  await expect.poll(() => state.uploads.length).toBe(1);
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(
    page.getByText('DEV: envio simulado', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => state.uploads.length).toBe(2);
  expect(state.uploads[0].postData()).toMatch(/name="origin"\r\n\r\nrecording/);
  expect(state.uploads[1].postData()).toMatch(
    /name="origin"\r\n\r\nattachment/,
  );
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0].postDataJSON()).toMatchObject({
    messageType: 'image',
    content: { mediaId: 'media-conversation-1' },
  });
});

test('MED-08 pending media send prevents concurrent text and capture', async ({
  page,
}) => {
  const state = await setup(page, { pendingSend: true });
  const text = page.getByRole('textbox', { name: 'Responder', exact: true });
  await text.fill('Texto sintético separado');
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect.poll(() => state.sends.length).toBe(1);
  await expect(text).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Gravar áudio', exact: true }),
  ).toBeDisabled();
  await state.releaseSend();
  await expect(text).toBeEnabled();
  expect(state.sends).toHaveLength(1);
  expect(state.sends[0].postDataJSON().messageType).toBe('image');
});

test('T25/MED-31: one contextual send preserves unsent text when a draft is removed', async ({
  page,
}) => {
  const state = await setup(page);
  const text = page.getByRole('textbox', { name: 'Responder', exact: true });
  await text.fill('Rascunho de texto preservado');
  await page
    .getByLabel('Arquivo para anexar')
    .setInputFiles('test/fixtures/media-composer.png');
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toHaveCount(0);
  await expect(text).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  expect(state.sends).toHaveLength(0);
  await page.getByRole('button', { name: 'Remover anexo' }).click();
  await expect(text).toHaveValue('Rascunho de texto preservado');
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toBeEnabled();
  // Opening the conversation by its address keeps it on screen on a phone,
  // where the Inbox shows one pane at a time.
  await page.locator('.conversation-row[aria-current="true"]').click();
  await expect(page).toHaveURL(/\/inbox\/conversation-1$/u);
  await expect(text).toHaveValue('Rascunho de texto preservado');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const mic = await page
      .getByRole('button', { name: 'Gravar áudio', exact: true })
      .boundingBox();
    const send = await page
      .getByRole('button', { name: 'Enviar resposta', exact: true })
      .boundingBox();
    if (!mic || !send) throw new Error('Composer actions must be visible');
    expect(mic.width).toBeGreaterThanOrEqual(44);
    expect(mic.height).toBeGreaterThanOrEqual(44);
    expect(send.width).toBeGreaterThanOrEqual(44);
    expect(send.height).toBeGreaterThanOrEqual(44);
    // Tools can wrap above Send. Measure the distance between their rectangles,
    // so both layouts enforce spacing and overlapping controls always fail.
    const horizontalGap = Math.max(
      0,
      send.x - (mic.x + mic.width),
      mic.x - (send.x + send.width),
    );
    const verticalGap = Math.max(
      0,
      send.y - (mic.y + mic.height),
      mic.y - (send.y + send.height),
    );
    expect(Math.hypot(horizontalGap, verticalGap)).toBeGreaterThanOrEqual(8);
    expect(send.x + send.width).toBeGreaterThanOrEqual(mic.x + mic.width);
  }
});

for (const viewport of [
  { width: 1366, height: 768 },
  { width: 1090, height: 689 },
  { width: 390, height: 667 },
  { width: 390, height: 440 },
]) {
  test(`T25/MED-01/25/31: large image keeps history and actions visible at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    const state = await setup(page);
    await page.locator('.conversation-row[aria-current="true"]').click();
    await page.setViewportSize(viewport);
    const thread = page.locator('.thread');
    const originalHeight = (await thread.boundingBox())?.height ?? 0;
    const image = await page.evaluate(() => {
      const canvas = globalThis.document.createElement('canvas');
      canvas.width = 1200;
      canvas.height = 1800;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.fillStyle = '#345678';
      context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    await page.getByLabel('Arquivo para anexar').setInputFiles({
      name: `${'imagem-sintetica'.repeat(12)}.png`,
      mimeType: 'image/png',
      buffer: Buffer.from(image, 'base64'),
    });
    const send = page.getByRole('button', {
      name: 'Enviar anexo',
      exact: true,
    });
    await expect(send).toBeEnabled();
    await expect(page.getByAltText('Prévia do anexo')).toBeVisible();
    const caption = page.getByLabel('Legenda');
    await caption.fill('Legenda sintética');
    await caption.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    // COB-REL-01 and T139 share the toolbar's native keyboard order.
    const billing = page.getByRole('button', {
      name: 'Cobranças e pagamentos',
      exact: true,
    });
    await expect(billing).toBeFocused();
    await expect(billing).toBeInViewport();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Cotar frete', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Gravar áudio', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(send).toBeFocused();

    const panelBox = await page.locator('.inbox-conversation').boundingBox();
    const threadBox = await thread.boundingBox();
    const toolbarBox = await page
      .locator('.media-composer__toolbar')
      .boundingBox();
    const reviewBox = await page
      .locator('.media-composer__review')
      .boundingBox();
    const sendBox = await send.boundingBox();
    if (!panelBox || !threadBox || !toolbarBox || !reviewBox || !sendBox)
      throw new Error('Conversation and attachment controls must be visible');
    expect(threadBox.height).toBeGreaterThanOrEqual(48);
    expect(threadBox.y + threadBox.height).toBeLessThanOrEqual(reviewBox.y);
    expect(reviewBox.y + reviewBox.height).toBeLessThanOrEqual(toolbarBox.y);
    expect(toolbarBox.y + toolbarBox.height).toBeLessThanOrEqual(
      panelBox.y + panelBox.height,
    );
    expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(viewport.height);
    expect(sendBox.width).toBeGreaterThanOrEqual(44);
    expect(sendBox.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    ).toBe(true);
    expect(state.sends).toHaveLength(0);
    const screenshotPath = testInfo.outputPath('attachment-layout.png');
    await page.screenshot({ path: screenshotPath });
    await testInfo.attach('attachment-layout', {
      path: screenshotPath,
      contentType: 'image/png',
    });

    await caption.focus();
    await caption.press('Shift+Tab');
    await expect(
      page.getByRole('button', { name: 'Ampliar prévia do anexo' }),
    ).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const remove = page.getByRole('button', { name: 'Remover anexo' });
    await expect(remove).toBeFocused();
    await remove.press('Enter');
    await expect(page.getByLabel('Responder', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
    ).toBeFocused();
    // The focused composer keeps the mobile navigation aside, so returning
    // to its attachment button can give the history 64px MORE room. Removing
    // the media must restore at least the original space, never shrink it.
    expect((await thread.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
      originalHeight,
    );
  });
}
