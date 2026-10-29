import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** @type {import('vite').ViteDevServer} */ let server;
let origin = '';
/** @type {{ cookie: string, range: string | undefined, status: number, contentRange: string | undefined }[]} */
const reads = [];
/** @type {Record<string, {bytes: Buffer, mime: string}>} */
const assets = {
  gif: {
    bytes: Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
      'base64',
    ),
    mime: 'image/gif',
  },
  image: {
    bytes: await readFile('test/fixtures/media-composer.png'),
    mime: 'image/png',
  },
  audio: {
    bytes: await readFile('test/fixtures/media-message.m4a'),
    mime: 'audio/mp4',
  },
  video: {
    bytes: await readFile('test/fixtures/media-composer.mp4'),
    mime: 'video/mp4',
  },
};
test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('apps/edge-web/vite.config.js'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
    plugins: [
      {
        name: 'private-media-message-fixture',
        configureServer(devServer) {
          devServer.middlewares.use(
            '/__media-message',
            async (req, res, next) => {
              if (req.url?.includes('html-proxy')) return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await devServer.transformIndexHtml(
                  '/__media-message',
                  (
                    await readFile('test/fixtures/media-composer.html', 'utf8')
                  ).replace(
                    '__FIXTURE_MODULE__',
                    resolve('test/fixtures/media-message.js').replaceAll(
                      '\\',
                      '/',
                    ),
                  ),
                ),
              );
            },
          );
          devServer.middlewares.use(
            '/api/v1/conversations/conversation-1/media/media-1/content',
            (req, res) => {
              const kind =
                new URL(req.headers.referer || origin).searchParams.get(
                  'kind',
                ) || 'image';
              const format = new URL(
                req.headers.referer || origin,
              ).searchParams.get('format');
              const asset = assets[format || kind];
              const cookie = req.headers.cookie || '';
              let status = cookie.includes('crm_session=synthetic-media-reader')
                ? 200
                : 401;
              let contentRange;
              let bytes = asset.bytes;
              if (status === 200 && req.headers.range) {
                const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
                const start = range ? Number(range[1]) : bytes.length;
                const end = range?.[2]
                  ? Math.min(Number(range[2]), bytes.length - 1)
                  : bytes.length - 1;
                if (start > end) status = 416;
                else {
                  status = 206;
                  contentRange = `bytes ${start}-${end}/${bytes.length}`;
                  bytes = bytes.subarray(start, end + 1);
                }
              }
              reads.push({
                cookie,
                range: req.headers.range,
                status,
                contentRange,
              });
              res.statusCode = status;
              res.setHeader('Cache-Control', 'private, no-store');
              res.setHeader('Accept-Ranges', 'bytes');
              res.setHeader('Content-Type', asset.mime);
              if (contentRange) res.setHeader('Content-Range', contentRange);
              res.setHeader('Content-Length', status < 400 ? bytes.length : 0);
              res.end(status < 400 ? bytes : undefined);
            },
          );
        },
      },
    ],
  });
  await server.listen();
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.httpServer?.address()).port}`;
});
test.afterAll(async () => {
  await server?.close();
});
test.beforeEach(async ({ context }) => {
  reads.length = 0;
  await context.addCookies([
    { name: 'crm_session', value: 'synthetic-media-reader', url: origin },
  ]);
});

test('MED-17/25 image decodes real private bytes with session', async ({
  page,
}) => {
  await page.goto(`${origin}/__media-message`);
  const image = page.getByRole('img', { name: 'Imagem da conversa' });
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate(
        (element) => /** @type {HTMLImageElement} */ (element).naturalWidth,
      ),
    )
    .toBeGreaterThan(0);
  expect(reads[0].cookie).toContain('crm_session=synthetic-media-reader');
  expect(reads[0].status).toBe(200);
});

test('IMG-01/ARQ-02 explicitly selects the order and attaches original image bytes by keyboard with retry', async ({
  page,
  context,
}) => {
  await context.addCookies([
    { name: 'crm_csrf', value: 'csrf-image-order', url: origin },
  ]);
  const attempts = /** @type {import('@playwright/test').Request[]} */ ([]);
  await page.route('**/api/v1/orders/*/files', async (route) => {
    const request = route.request();
    attempts.push(request);
    if (attempts.length === 1)
      return route.fulfill({
        status: 503,
        json: { code: 'FILE_STORAGE_UNAVAILABLE' },
      });
    return route.fulfill({
      json: { references: [{ id: 'reference-one' }], final: null },
    });
  });
  await page.goto(`${origin}/__media-message?orders`);
  const button = page.getByRole('button', {
    name: 'Anexar ao pedido',
    exact: true,
  });
  await button.focus();
  await page.keyboard.press('Enter');
  expect(attempts).toHaveLength(0);
  await page.getByLabel('Anexar imagem ao pedido').selectOption('order-two');
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Arquivos indisponíveis');
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(
    'Imagem anexada ao pedido 02-CRM.',
  );
  expect(attempts).toHaveLength(2);
  for (const attempt of attempts) {
    expect(new URL(attempt.url()).pathname).toBe(
      '/api/v1/orders/order-two/files',
    );
    expect(attempt.method()).toBe('POST');
    expect(attempt.headers()['x-csrf-token']).toBe('csrf-image-order');
    const bytes = attempt.postDataBuffer();
    expect(bytes?.includes(assets.image.bytes)).toBe(true);
    expect(bytes?.toString()).toContain('name="slot"\r\n\r\nreference');
    expect(bytes?.toString()).toContain('filename="imagem-media-1.png"');
  }
  expect(attempts[0].headers()['idempotency-key']).toBeTruthy();
  expect(attempts[1].headers()['idempotency-key']).toBe(
    attempts[0].headers()['idempotency-key'],
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('IMG-02 expired content never uploads an order file', async ({ page }) => {
  await page.goto(`${origin}/__media-message?orders`);
  await expect(
    page.getByRole('img', { name: 'Imagem da conversa' }),
  ).toBeVisible();
  const uploads = /** @type {import('@playwright/test').Route[]} */ ([]);
  await page.route('**/api/v1/orders/*/files', (route) => {
    uploads.push(route);
    return route.fulfill({ json: {} });
  });
  await page.route('**/api/v1/conversations/**/content', (route) =>
    route.fulfill({ status: 410, body: '' }),
  );
  await page.getByLabel('Anexar imagem ao pedido').selectOption('order-one');
  await page
    .getByRole('button', { name: 'Anexar ao pedido', exact: true })
    .click();
  await expect(page.getByRole('alert')).toHaveText(
    'Esta imagem não está mais disponível para anexar.',
  );
  expect(uploads).toHaveLength(0);
});

test('IMG-02 no editable order or lost image offers no attachment command', async ({
  page,
}) => {
  await page.goto(`${origin}/__media-message`);
  await expect(
    page.getByRole('button', { name: 'Anexar ao pedido', exact: true }),
  ).toHaveCount(0);
  await page.goto(`${origin}/__media-message?orders&state=lost`);
  await expect(
    page.getByRole('button', { name: 'Anexar ao pedido', exact: true }),
  ).toHaveCount(0);
});

test('IMG-06 GIF renders and attaches its original bytes', async ({ page }) => {
  const uploads = /** @type {import('@playwright/test').Request[]} */ ([]);
  await page.route('**/api/v1/orders/*/files', (route) => {
    uploads.push(route.request());
    return route.fulfill({
      json: { references: [{ id: 'gif-reference' }], final: null },
    });
  });
  await page.goto(origin + '/__media-message?orders&format=gif');
  const image = page.getByRole('img', { name: 'Imagem da conversa' });
  await expect
    .poll(() =>
      image.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth),
    )
    .toBe(1);
  await page.getByLabel('Anexar imagem ao pedido').selectOption('order-one');
  await page
    .getByRole('button', { name: 'Anexar ao pedido', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    'Imagem anexada ao pedido 01-CRM.',
  );
  expect(uploads).toHaveLength(1);
  expect(uploads[0].postDataBuffer()?.includes(assets.gif.bytes)).toBe(true);
  expect(uploads[0].postDataBuffer()?.toString()).toContain(
    'filename="imagem-media-1.gif"',
  );
});

test('IMG-07 full order announces the five-file limit and preserves keyboard retry', async ({
  page,
}) => {
  await page.route('**/api/v1/orders/*/files', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'FILE_LIMIT_REACHED' } },
    }),
  );
  await page.goto(origin + '/__media-message?orders');
  await page.getByLabel('Anexar imagem ao pedido').selectOption('order-one');
  const button = page.getByRole('button', {
    name: 'Anexar ao pedido',
    exact: true,
  });
  await button.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(
    'Limite de 5 arquivos atingido. Remova um para enviar outro.',
  );
  await expect(button).toBeFocused();
  await expect(page.getByText('Imagem anexada', { exact: false })).toHaveCount(
    0,
  );
});

test('IMG-08 image bytes with unsupported MIME are never uploaded', async ({
  page,
}) => {
  await page.goto(origin + '/__media-message?orders');
  await expect(
    page.getByRole('img', { name: 'Imagem da conversa' }),
  ).toBeVisible();
  await page.route('**/api/v1/conversations/**/content', (route) =>
    route.fulfill({
      contentType: 'application/octet-stream',
      body: assets.image.bytes,
    }),
  );
  const uploads = /** @type {import('@playwright/test').Request[]} */ ([]);
  await page.route('**/api/v1/orders/*/files', (route) => {
    uploads.push(route.request());
    return route.fulfill({ json: {} });
  });
  await page.getByLabel('Anexar imagem ao pedido').selectOption('order-one');
  await page
    .getByRole('button', { name: 'Anexar ao pedido', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('o formato não é aceito');
  expect(uploads).toHaveLength(0);
});

for (const kind of ['audio', 'video']) {
  test(`MED-17/25 ${kind} plays and seeks real authenticated Range bytes without autoplay`, async ({
    page,
  }) => {
    await page.goto(`${origin}/__media-message?kind=${kind}`);
    const player = page.locator(kind);
    await expect(player).toHaveAttribute('controls', '');
    await expect(player).toHaveAttribute('preload', 'metadata');
    await expect(player).not.toHaveAttribute('autoplay', /.*/);
    await expect
      .poll(() =>
        player.evaluate(
          (element) => /** @type {HTMLMediaElement} */ (element).readyState,
        ),
      )
      .toBeGreaterThanOrEqual(1);
    expect(
      await player.evaluate(
        (element) => /** @type {HTMLMediaElement} */ (element).paused,
      ),
    ).toBe(true);
    await player.evaluate(async (element) => {
      const media = /** @type {HTMLMediaElement} */ (element);
      media.currentTime = 0.5;
      await media.play();
    });
    await expect
      .poll(() =>
        player.evaluate(
          (element) => /** @type {HTMLMediaElement} */ (element).currentTime,
        ),
      )
      .toBeGreaterThan(0.5);
    expect(
      await player.evaluate(
        (element) => /** @type {HTMLMediaElement} */ (element).error,
      ),
    ).toBeNull();
    const ranged = reads.find((read) => read.status === 206);
    expect(ranged?.cookie).toContain('crm_session=synthetic-media-reader');
    expect(ranged?.range).toBe('bytes=0-');
    expect(ranged?.contentRange).toBe(
      `bytes 0-${assets[kind].bytes.length - 1}/${assets[kind].bytes.length}`,
    );
  });
}

test('MED-25 lost transition restores focus from removed native player to notice', async ({
  page,
}) => {
  await page.goto(`${origin}/__media-message?kind=audio`);
  const player = page.locator('audio');
  await player.focus();
  await page
    .getByRole('button', { name: 'Marcar arquivo perdido' })
    .evaluate((element) => /** @type {HTMLButtonElement} */ (element).click());
  await expect(page.locator('audio')).toHaveCount(0);
  await expect(page.getByRole('status')).toBeFocused();
});

test('MED-25 content failure restores focus from removed player to notice', async ({
  page,
}) => {
  /** @type {import('@playwright/test').Route | null} */ let contentRoute =
    null;
  await page.route('**/api/v1/conversations/**/content', (route) => {
    contentRoute = route;
  });
  await page.goto(`${origin}/__media-message?kind=audio`);
  await page.locator('audio').focus();
  await expect.poll(() => Boolean(contentRoute)).toBe(true);
  await /** @type {import('@playwright/test').Route | null} */ (
    contentRoute
  )?.fulfill({ status: 503, body: '' });
  await expect(page.getByRole('status')).toHaveText(
    'Arquivo indisponível no momento.',
  );
  await expect(page.getByRole('status')).toBeFocused();
});

test('MED-19 lost file preserves accessible history without bytes request', async ({
  page,
}) => {
  await page.goto(`${origin}/__media-message?state=lost`);
  await expect(page.getByRole('status')).toHaveText(
    'Arquivo perdido. O histórico da mensagem foi preservado.',
  );
  await expect(page.locator('img,audio,video')).toHaveCount(0);
  expect(reads).toHaveLength(0);
});

test('MED-19 unavailable storage announces failure without delivery claim', async ({
  page,
}) => {
  await page.route('**/api/v1/conversations/**/content', (route) =>
    route.fulfill({ status: 503, body: '' }),
  );
  await page.goto(`${origin}/__media-message?kind=audio`);
  await expect(page.getByRole('status')).toHaveText(
    'Arquivo indisponível no momento.',
  );
  await expect(page.locator('audio')).toHaveCount(0);
  await expect(page.getByText('Mensagem enviada', { exact: true })).toHaveCount(
    0,
  );
});

test('MED-16/19 foreign content URL never requests external storage', async ({
  page,
}) => {
  const external = /** @type {string[]} */ ([]);
  page.on('request', (request) => {
    if (request.url().includes('storage.invalid')) external.push(request.url());
  });
  await page.goto(`${origin}/__media-message?unsafe`);
  await expect(page.getByRole('status')).toHaveText(
    'Arquivo indisponível no momento.',
  );
  expect(external).toHaveLength(0);
  expect(reads).toHaveLength(0);
});

test('MED-19/25 lost transition removes player and remains keyboard and axe accessible', async ({
  page,
}) => {
  await page.goto(`${origin}/__media-message?kind=audio`);
  await page.getByRole('button', { name: 'Marcar arquivo perdido' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(
    'Arquivo perdido. O histórico da mensagem foi preservado.',
  );
  await expect(page.locator('audio')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Marcar arquivo perdido' }),
  ).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const kind of ['audio', 'video']) {
  test(`MED-25 ${kind} native player is operable by keyboard and axe accessible`, async ({
    page,
  }) => {
    await page.goto(`${origin}/__media-message?kind=${kind}`);
    const player = page.locator(kind);
    await expect
      .poll(() =>
        player.evaluate(
          (element) => /** @type {HTMLMediaElement} */ (element).readyState,
        ),
      )
      .toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Marcar arquivo perdido' }).focus();
    await page.keyboard.press('Tab');
    expect(
      await player.evaluate(
        (element) => element === globalThis.document.activeElement,
      ),
    ).toBe(true);
    await page.keyboard.press('Space');
    await expect
      .poll(() =>
        player.evaluate(
          (element) => /** @type {HTMLMediaElement} */ (element).paused,
        ),
      )
      .toBe(false);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}
