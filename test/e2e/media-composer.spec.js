import { expect, test } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { createServer } from 'vite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** @type {import('vite').ViteDevServer} */ let server;
let origin = '';
const png = await readFile('test/fixtures/media-composer.png');
const audio = await readFile('test/fixtures/media-composer.m4a');
const video = await readFile('test/fixtures/media-composer.mp4');

test.beforeAll(async () => {
  server = await createServer({
    configFile: resolve('apps/edge-web/vite.config.js'),
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'silent',
    plugins: [
      {
        name: 'isolated-media-composer-fixture',
        configureServer(devServer) {
          devServer.middlewares.use(
            '/__media-composer',
            async (req, res, next) => {
              if (req.url?.includes('html-proxy')) return next();
              res.setHeader('Content-Type', 'text/html');
              res.end(
                await devServer.transformIndexHtml(
                  '/__media-composer',
                  (
                    await readFile('test/fixtures/media-composer.html', 'utf8')
                  ).replace(
                    '__FIXTURE_MODULE__',
                    resolve('test/fixtures/media-composer.js').replaceAll(
                      '\\',
                      '/',
                    ),
                  ),
                ),
              );
            },
          );
        },
      },
    ],
  });
  await server.listen();
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.httpServer?.address()
  );
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
});
/** @param {import('@playwright/test').Page} page @param {any} [options] */
async function setup(page, options = {}) {
  const uploads = /** @type {import('@playwright/test').Request[]} */ ([]),
    sends = /** @type {import('@playwright/test').Request[]} */ ([]);
  let polls = 0;
  await page.route('**/api/v1/conversations/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path.endsWith('/media')) {
      uploads.push(req);
      if (
        options.uploadDelay &&
        (!options.oldOnly || path.includes('conversation-1'))
      )
        await new Promise((resolve) =>
          setTimeout(resolve, options.uploadDelay),
        );
      if (options.uploadError && uploads.length === 1)
        return route.fulfill({
          status: options.uploadStatus ?? 503,
          json: { error: { code: 'SERVICE_UNAVAILABLE' } },
        });
      return route.fulfill({
        status: 202,
        json: {
          mediaId: path.includes('conversation-2') ? 'media-2' : 'media-1',
          state: 'processing',
        },
      });
    }
    if (req.method() === 'POST' && path.endsWith('/messages')) {
      sends.push(req);
      if (options.pendingSend && sends.length === 1) return;
      if (options.sendError && sends.length === 1) return route.abort('failed');
      if (options.sendStatus && sends.length === 1)
        return route.fulfill({
          status: options.sendStatus,
          json: {
            accepted: false,
            error: {
              code: options.sendCode,
              detail: 'PRIVATE_SEND_ERROR_CANARY',
            },
          },
        });
      return route.fulfill({
        status: 202,
        json: { id: 'message-1', status: 'pending' },
      });
    }
    polls++;
    if (options.pendingStatus) return;
    if (options.beforeStatus) await options.beforeStatus(polls);
    return route.fulfill({
      status: 200,
      json: {
        mediaId: path.includes('conversation-2') ? 'media-2' : 'media-1',
        kind: options.kind ?? 'image',
        state:
          options.stateSequence?.[polls - 1] ??
          (options.rejected
            ? 'rejected'
            : options.processingForever
              ? 'processing'
              : options.processing && polls === 1
                ? 'processing'
                : 'ready'),
        reason:
          options.statusReason ??
          (options.rejected ? 'invalid_format' : undefined),
      },
    });
  });
  await page.goto(origin + '/__media-composer');
  return {
    uploads,
    sends,
    get polls() {
      return polls;
    },
  };
}
/** @param {import('@playwright/test').Page} page @param {string} [name] @param {string} [mime] */
async function select(page, name = 'sample.png', mime = 'image/png') {
  await page.getByLabel('Arquivo para anexar').setInputFiles({
    name,
    mimeType: mime,
    buffer:
      name === 'renamed.png'
        ? Buffer.from('invalid bytes renamed as PNG')
        : name.endsWith('.m4a')
          ? audio
          : name.endsWith('.mp4')
            ? video
            : png,
  });
}
/** @param {import('@playwright/test').Page} page */
async function ready(page) {
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
}

test('INBOX-UX-03 image review keeps a long filename and caption compact with an expandable preview', async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1366, height: 768 });
  await select(
    page,
    'referencia-da-estampa-da-camiseta-infantil-para-a-turma-da-escola.png',
  );
  await ready(page);
  const review = page.locator('.media-composer__review');
  const box = await review.boundingBox();
  expect(box?.height).toBeLessThan(180);
  const caption = page.getByLabel('Legenda');
  await expect(caption).toHaveAttribute('rows', '1');
  const counter = page.getByText('0/1024 caracteres', { exact: true });
  const counterBox = await counter.boundingBox();
  expect(counterBox?.width).toBeLessThanOrEqual(1);
  expect(counterBox?.height).toBeLessThanOrEqual(1);
  await expect(caption).toHaveAccessibleDescription('0/1024 caracteres');
  await caption.fill('a'.repeat(900));
  const nearLimitCounter = page.getByText('900/1024 caracteres', {
    exact: true,
  });
  await expect(nearLimitCounter).toBeVisible();
  const nearLimitBox = await nearLimitCounter.boundingBox();
  expect(nearLimitBox?.width).toBeGreaterThan(1);
  expect(nearLimitBox?.height).toBeGreaterThan(1);
  await page.getByRole('button', { name: 'Ampliar prévia do anexo' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Prévia ampliada do anexo' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('button', { name: 'Ampliar prévia do anexo' }),
  ).toBeFocused();
});

for (const [reason, message] of [
  [
    'stale_signatures',
    'A verificação de segurança está temporariamente indisponível. Aguarde a atualização do serviço e tente validar novamente.',
  ],
  [
    'scanner_unavailable',
    'A verificação de segurança está temporariamente indisponível. Tente validar novamente em alguns instantes.',
  ],
  [
    'storage_unavailable',
    'O armazenamento está temporariamente indisponível. Tente validar novamente em alguns instantes.',
  ],
  [
    'processing_failed',
    'Não foi possível concluir a validação. Tente validar novamente em alguns instantes.',
  ],
])
  test(`T27/MED-26/32: ${reason} preserves draft and retries status without another upload`, async ({
    page,
  }) => {
    const { uploads, sends } = await setup(page, {
      stateSequence: ['unavailable', 'processing', 'ready'],
      statusReason: reason,
    });
    await select(page);
    await page.getByLabel('Legenda').fill('Legenda preservada');
    await expect(page.getByRole('alert')).toHaveText(message);
    await expect(
      page.getByRole('button', { name: 'Enviar anexo', exact: true }),
    ).toBeDisabled();
    await expect(page.getByAltText('Prévia do anexo')).toBeVisible();
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(0);
    await page
      .getByRole('button', { name: 'Atualizar validação', exact: true })
      .click();
    await ready(page);
    await expect(page.getByLabel('Legenda')).toHaveValue('Legenda preservada');
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(0);
    await page
      .getByRole('button', { name: 'Enviar anexo', exact: true })
      .click();
    await expect.poll(() => sends.length).toBe(1);
    expect(sends[0].postDataJSON().content).toEqual({
      mediaId: 'media-1',
      caption: 'Legenda preservada',
    });
  });

for (const [state, reason] of [
  ['lost', 'stale_signatures'],
  ['unavailable', 'PRIVATE_STATUS_REASON'],
])
  test(`T27/MED-19/32: ${state}/${reason} remains blocked without arbitrary server details`, async ({
    page,
  }) => {
    const { uploads, sends } = await setup(page, {
      stateSequence: [state],
      statusReason: reason,
    });
    await select(page);
    await expect(page.getByRole('alert')).toHaveText(
      'Arquivo indisponível. Escolha outro arquivo.',
    );
    await expect(
      page.getByRole('button', { name: 'Enviar anexo', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: 'Atualizar validação', exact: true }),
    ).toHaveCount(0);
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(0);
  });

for (const [kind, name, mime] of [
  ['image', 'sample.png', 'image/png'],
  ['audio', 'sample.m4a', 'audio/x-m4a'],
  ['audio', 'sample.m4a', 'audio/m4a'],
  ['video', 'sample.mp4', 'video/mp4'],
])
  test(`T18/MED-01/02/03: explicit ${kind} ${mime} review sends exactly one ready media with native multipart`, async ({
    page,
  }) => {
    const { uploads, sends } = await setup(page, { kind, processing: true });
    await select(page, name, mime);
    await expect(
      page.getByRole('button', { name: 'Enviar anexo', exact: true }),
    ).toBeDisabled();
    await expect.poll(() => uploads.length).toBe(1);
    expect(sends).toHaveLength(0);
    await ready(page);
    if (kind === 'audio')
      await expect(page.getByLabel('Legenda')).toHaveCount(0);
    else await page.getByLabel('Legenda').fill('Revisão explícita');
    expect(sends).toHaveLength(0);
    await page
      .getByRole('button', { name: 'Enviar anexo', exact: true })
      .click();
    await expect(
      page.getByText('Mensagem enviada', { exact: true }),
    ).toBeVisible();
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(uploads[0].headers()['content-type']).toContain(
      'multipart/form-data; boundary=',
    );
    expect(sends[0].postDataJSON()).toEqual({
      expectedVersion: 4,
      messageType: kind,
      content:
        kind === 'audio'
          ? { mediaId: 'media-1' }
          : { mediaId: 'media-1', caption: 'Revisão explícita' },
      reason: 'Envio humano de anexo',
    });
  });
test('T18/MED-04: empty MIME is a hint and renamed invalid bytes are rejected by processing', async ({
  page,
}) => {
  const { uploads, sends } = await setup(page, { rejected: true });
  await select(page, 'renamed.png', '');
  await expect(page.getByRole('alert')).toContainText('Formato inválido');
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  expect(uploads).toHaveLength(1);
  expect(sends).toHaveLength(0);
});
test('T18/MED-01/04: approved empty-MIME file can complete byte validation and send', async ({
  page,
}) => {
  const { sends } = await setup(page);
  await select(page, 'sample.png', '');
  await ready(page);
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(
    page.getByText('Mensagem enviada', { exact: true }),
  ).toBeVisible();
  expect(sends).toHaveLength(1);
});
test('T18/MED-04: caption counts Unicode code points including 1024 emoji', async ({
  page,
}) => {
  const { sends } = await setup(page);
  await select(page);
  await ready(page);
  const caption = page.getByLabel('Legenda');
  await caption.fill('😀'.repeat(1025));
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  await caption.fill('😀'.repeat(1024));
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(
    page.getByText('Mensagem enviada', { exact: true }),
  ).toBeVisible();
  expect([...sends[0].postDataJSON().content.caption]).toHaveLength(1024);
});
test('T18/MED-06: retry preserves original upload key, file and version after network error', async ({
  page,
}) => {
  const { uploads } = await setup(page, { uploadError: true });
  await select(page);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Tentar carregar novamente' }).click();
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  expect(uploads).toHaveLength(2);
  expect(uploads[0].headers()['idempotency-key']).toEqual(
    uploads[1].headers()['idempotency-key'],
  );
  expect(uploads[0].postData()).toContain('sample.png');
  expect(uploads[1].postData()).toContain('name="expectedVersion"\r\n\r\n4');
});
test('T18/MED-06: uncertain send preserves preview, payload and original send key', async ({
  page,
}) => {
  const { sends } = await setup(page, { sendError: true });
  await select(page);
  await ready(page);
  await page.getByLabel('Legenda').fill('Original');
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  await expect(page.getByLabel('Legenda')).toBeDisabled();
  await page.getByRole('button', { name: 'Tentar enviar novamente' }).click();
  await expect(
    page.getByText('Mensagem enviada', { exact: true }),
  ).toBeVisible();
  expect(sends).toHaveLength(2);
  expect(sends[0].headers()['idempotency-key']).toEqual(
    sends[1].headers()['idempotency-key'],
  );
  expect(sends[0].postDataJSON()).toEqual(sends[1].postDataJSON());
});
test('T18/MED-06/25: reenable after pending send retries the immutable original attempt explicitly', async ({
  page,
}) => {
  const { uploads, sends } = await setup(page, { pendingSend: true });
  await select(page);
  await ready(page);
  await page.getByLabel('Legenda').fill('Original');
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect.poll(() => sends.length).toBe(1);
  await page.getByRole('button', { name: 'Bloquear envio' }).click();
  const retry = page.getByRole('button', { name: 'Tentar enviar novamente' });
  await expect(retry).toBeDisabled();
  await expect(page.getByLabel('Legenda')).toBeDisabled();
  await page.getByRole('button', { name: 'Reabilitar envio' }).click();
  await expect(retry).toBeEnabled();
  expect(sends).toHaveLength(1);
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Mensagem enviada', { exact: true }),
  ).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(sends).toHaveLength(2);
  expect(sends[0].headers()['idempotency-key']).toEqual(
    sends[1].headers()['idempotency-key'],
  );
  expect(sends[0].postDataJSON()).toEqual(sends[1].postDataJSON());
  expect(new URL(sends[1].url()).pathname).toBe(
    '/api/v1/conversations/conversation-1/messages',
  );
  expect(sends[1].postDataJSON()).toEqual({
    expectedVersion: 4,
    messageType: 'image',
    content: { mediaId: 'media-1', caption: 'Original' },
    reason: 'Envio humano de anexo',
  });
});

test('T18/MED-25: remove and reselect by keyboard restores focus and clears the previous draft', async ({
  page,
}) => {
  await setup(page);
  await select(page);
  const remove = page.getByRole('button', { name: 'Remover anexo' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
  ).toBeFocused();
  await expect(page.getByRole('img', { name: 'Prévia do anexo' })).toHaveCount(
    0,
  );
  await select(page);
  await expect(page.getByLabel('Legenda')).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('Legenda')).toBeFocused();
});
test('T18/MED-07/08: switch or unmount cancels stale upload and cannot send it in another conversation', async ({
  page,
}) => {
  const { sends } = await setup(page, { uploadDelay: 250 });
  await select(page);
  await page.getByRole('button', { name: 'Trocar conversa' }).click();
  await expect(page.getByRole('img', { name: 'Prévia do anexo' })).toHaveCount(
    0,
  );
  await page.waitForTimeout(350);
  expect(sends).toHaveLength(0);
  await select(page);
  await page.getByRole('button', { name: 'Fechar composer' }).click();
  await page.waitForTimeout(350);
  expect(sends).toHaveLength(0);
});
test('T18/MED-08/25: blocked composer has no upload action and passes axe with a ready draft', async ({
  page,
}) => {
  const { uploads, sends } = await setup(page);
  await select(page);
  await ready(page);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Bloquear envio' }).click();
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  expect(uploads).toHaveLength(1);
  expect(sends).toHaveLength(0);
});
test('T18/MED-07/08: delayed original upload cannot replace the new conversation draft', async ({
  page,
}) => {
  const { uploads, sends } = await setup(page, {
    uploadDelay: 250,
    oldOnly: true,
  });
  await select(page);
  await page.getByRole('button', { name: 'Trocar conversa' }).click();
  await select(page);
  await ready(page);
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(
    page.getByText('Mensagem enviada', { exact: true }),
  ).toBeVisible();
  expect(uploads).toHaveLength(2);
  expect(sends).toHaveLength(1);
  expect(new URL(sends[0].url()).pathname).toBe(
    '/api/v1/conversations/conversation-2/messages',
  );
  expect(sends[0].postDataJSON().content.mediaId).toBe('media-2');
});
test('T18/MED-04: valid local pipeline beyond 340 seconds remains eligible before polling budget expires', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-06T00:00:00Z') });
  await setup(page, { processing: true });
  await select(page);
  await expect(page.getByRole('status')).toContainText('Validando arquivo');
  await page.clock.fastForward(350000);
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('T18/MED-04/06: polling timeout preserves media ID and a status retry can observe the eventual ready state', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-06T00:00:00Z') });
  const options = { processingForever: true };
  const { uploads } = await setup(page, options);
  await select(page);
  await expect(page.getByRole('status')).toContainText('Validando arquivo');
  const secondPoll = page.waitForResponse('**/media/media-1');
  await page.clock.fastForward(599000);
  await (await secondPoll).finished();
  await page.clock.runFor(1000);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  options.processingForever = false;
  await page.getByRole('button', { name: 'Atualizar validação' }).click();
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeEnabled();
  expect(uploads).toHaveLength(1);
});

test('T18/MED-04/06: polling budget aborts a pending status GET without losing the draft', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-06T00:00:00Z') });
  const { uploads } = await setup(page, { pendingStatus: true });
  const pending = page.waitForRequest('**/media/media-1');
  await select(page);
  await pending;
  await page.clock.fastForward(600000);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Prévia do anexo' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Atualizar validação' }),
  ).toBeEnabled();
  expect(uploads).toHaveLength(1);
});

test('T25/MED-30/31: selection validates automatically, permits caption editing and never sends without confirmation', async ({
  page,
}) => {
  const { uploads, sends } = await setup(page, {
    uploadDelay: 250,
    processing: true,
  });
  await select(page);
  await expect(page.getByRole('button', { name: /Preparar/ })).toHaveCount(0);
  const caption = page.getByLabel('Legenda');
  await expect(caption).toBeEnabled();
  await caption.fill('Legenda escrita enquanto carrega');
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  await ready(page);
  await expect(caption).toHaveValue('Legenda escrita enquanto carrega');
  await expect(caption).toBeFocused();
  expect(uploads).toHaveLength(1);
  expect(sends).toHaveLength(0);
  await page.getByRole('button', { name: 'Enviar anexo', exact: true }).click();
  await expect(
    page.getByText('Mensagem enviada', { exact: true }),
  ).toBeVisible();
  expect(sends[0].postDataJSON().content.caption).toBe(
    'Legenda escrita enquanto carrega',
  );
});

test('T25/MED-30: queued uploaded media progresses through processing to ready without manual retry or sending', async ({
  page,
}) => {
  const result = await setup(page, {
    stateSequence: ['uploaded', 'processing', 'ready'],
  });
  await select(page);
  await expect(page.getByRole('status')).toContainText('Validando arquivo');
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  await expect.poll(() => result.polls).toBe(2);
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await ready(page);
  expect(result.polls).toBe(3);
  expect(result.uploads).toHaveLength(1);
  expect(result.sends).toHaveLength(0);
  await expect(
    page.getByRole('button', { name: 'Atualizar validação' }),
  ).toHaveCount(0);
});

test('T25/MED-25/30: background validation preserves focus on the audio preview', async ({
  page,
}) => {
  const { sends } = await setup(page, { kind: 'audio', processing: true });
  await select(page, 'sample.m4a', 'audio/mp4');
  await expect(page.getByRole('status')).toContainText('Validando arquivo');
  const player = page.getByLabel('Prévia do áudio');
  await player.focus();
  await expect(player).toBeFocused();
  await ready(page);
  await expect(player).toBeFocused();
  expect(sends).toHaveLength(0);
});

/** @type {Array<[number, string]>} */
const uploadErrors = [
  [401, 'Sua sessão expirou'],
  [403, 'Você não pode anexar arquivos nesta conversa'],
  [404, 'Anexos estão indisponíveis neste ambiente'],
  [413, 'O arquivo ultrapassa o limite permitido'],
  [429, 'Há muitos arquivos sendo carregados'],
  [503, 'O serviço de anexos está temporariamente indisponível'],
];
for (const [code, message] of uploadErrors)
  test(`T25/MED-32: upload ${code} explains recovery and preserves the original draft and key`, async ({
    page,
  }) => {
    const { uploads, sends } = await setup(page, {
      uploadError: true,
      uploadStatus: code,
    });
    await select(page);
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(
      page.getByRole('img', { name: 'Prévia do anexo' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Enviar anexo', exact: true }),
    ).toBeDisabled();
    expect(sends).toHaveLength(0);
    await page
      .getByRole('button', { name: 'Tentar carregar novamente' })
      .click();
    await ready(page);
    expect(uploads).toHaveLength(2);
    expect(uploads[0].headers()['idempotency-key']).toBe(
      uploads[1].headers()['idempotency-key'],
    );
    expect(sends).toHaveLength(0);
  });

test('T25/MED-25/31: attachment picker is styled, keyboard operable and sized for mobile without overflow', async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 360, height: 800 });
  const attach = page.getByRole('button', {
    name: 'Anexar arquivo',
    exact: true,
  });
  await expect(attach).toBeVisible();
  await expect(page.getByLabel('Arquivo para anexar')).toBeHidden();
  const box = await attach.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await attach.focus();
  const picker = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await picker).setFiles('test/fixtures/media-composer.png');
  await ready(page);
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

/** @type {Array<[number, string, string, boolean]>} */
const sendRefusals = [
  [
    401,
    'INVALID_REQUEST',
    'Sua sessão expirou. Entre novamente antes de tentar o mesmo envio.',
    true,
  ],
  [
    403,
    'INBOX_FORBIDDEN',
    'Este envio não é permitido. Verifique o responsável pelo atendimento e a disponibilidade dos anexos antes de tentar novamente.',
    true,
  ],
  [
    429,
    'INVALID_REQUEST',
    'Há muitos envios em andamento. Aguarde um pouco antes de tentar o mesmo envio.',
    true,
  ],
  [
    400,
    'INBOX_INVALID',
    'O anexo ou a legenda foi recusado. Remova o anexo, revise o arquivo e selecione novamente antes de enviar.',
    false,
  ],
  [
    404,
    'INVALID_REQUEST',
    'A conversa ou o serviço de anexos não está disponível. Remova o anexo e confira a conversa antes de selecionar novamente.',
    false,
  ],
  [
    409,
    'INBOX_CONFLICT',
    'A conversa ou o anexo mudou. Remova o anexo, atualize a conversa e selecione novamente antes de enviar.',
    false,
  ],
  [
    413,
    'INVALID_REQUEST',
    'O arquivo ultrapassa o limite permitido. Remova o anexo e escolha um arquivo menor.',
    false,
  ],
  [
    422,
    'INBOX_INVALID',
    'O anexo ou a legenda foi recusado. Remova o anexo, revise o arquivo e selecione novamente antes de enviar.',
    false,
  ],
];
for (const [code, sendCode, message, retryAllowed] of sendRefusals)
  test(`T25-FIX1/MED-32: known send refusal ${code} preserves the draft and offers the appropriate action without exposing private details`, async ({
    page,
  }) => {
    const { uploads, sends } = await setup(page, {
      sendStatus: code,
      sendCode,
    });
    await select(page);
    await ready(page);
    await page.getByLabel('Legenda').fill('Legenda original');
    await page
      .getByRole('button', { name: 'Enviar anexo', exact: true })
      .click();
    await expect(page.getByRole('alert')).toHaveText(message);
    await expect(page.getByRole('alert')).not.toContainText(
      'PRIVATE_SEND_ERROR_CANARY',
    );
    await expect(
      page.getByRole('img', { name: 'Prévia do anexo' }),
    ).toBeVisible();
    await expect(page.getByLabel('Legenda')).toHaveValue('Legenda original');
    await expect(page.getByLabel('Legenda')).toBeDisabled();
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(1);
    if (retryAllowed) {
      const retry = page.getByRole('button', {
        name: 'Tentar enviar novamente',
      });
      await expect(retry).toBeEnabled();
      await retry.click();
      await expect(
        page.getByText('Mensagem enviada', { exact: true }),
      ).toBeVisible();
      expect(sends).toHaveLength(2);
      expect(sends[0].headers()['idempotency-key']).toBe(
        sends[1].headers()['idempotency-key'],
      );
      expect(sends[0].postDataJSON()).toEqual(sends[1].postDataJSON());
      expect(uploads).toHaveLength(1);
    } else {
      await expect(
        page.getByRole('button', { name: 'Envio indisponível', exact: true }),
      ).toBeDisabled();
      const remove = page.getByRole('button', { name: 'Remover anexo' });
      await expect(remove).toBeEnabled();
      await remove.click();
      await expect(
        page.getByRole('img', { name: 'Prévia do anexo' }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Anexar arquivo', exact: true }),
      ).toBeFocused();
      expect(sends).toHaveLength(1);
    }
  });

/** @type {Array<[number, string]>} */
const uncertainSendErrors = [
  [503, 'SERVICE_UNAVAILABLE'],
  [409, 'PRIVATE_SEND_ERROR_CANARY'],
];
for (const [code, sendCode] of uncertainSendErrors)
  test(`T25-FIX1/MED-06/32: uncertain or unrecognized send ${code}/${sendCode} keeps the immutable original attempt`, async ({
    page,
  }) => {
    const { sends } = await setup(page, { sendStatus: code, sendCode });
    await select(page);
    await ready(page);
    await page.getByLabel('Legenda').fill('Legenda original');
    await page
      .getByRole('button', { name: 'Enviar anexo', exact: true })
      .click();
    await expect(page.getByRole('alert')).toHaveText(
      'Não foi possível confirmar o envio. Tente novamente para consultar o mesmo envio.',
    );
    await expect(page.getByRole('alert')).not.toContainText(
      'PRIVATE_SEND_ERROR_CANARY',
    );
    await expect(page.getByLabel('Legenda')).toBeDisabled();
    await page.getByRole('button', { name: 'Tentar enviar novamente' }).click();
    await expect(
      page.getByText('Mensagem enviada', { exact: true }),
    ).toBeVisible();
    expect(sends).toHaveLength(2);
    expect(sends[0].headers()['idempotency-key']).toBe(
      sends[1].headers()['idempotency-key'],
    );
    expect(sends[0].postDataJSON()).toEqual(sends[1].postDataJSON());
  });

test('T27/MED-06/32: caption entered before temporary validation failure survives the response', async ({
  page,
}) => {
  let releaseStatus = () => {};
  const statusGate = new Promise((resolve) => {
    releaseStatus = () => resolve(undefined);
  });
  const { uploads, sends } = await setup(page, {
    stateSequence: ['unavailable'],
    statusReason: 'stale_signatures',
    beforeStatus: () => statusGate,
  });
  await select(page);
  await page.getByLabel('Legenda').fill('Legenda antes da falha');
  releaseStatus();
  await expect(page.getByRole('alert')).toHaveText(
    'A verificação de segurança está temporariamente indisponível. Aguarde a atualização do serviço e tente validar novamente.',
  );
  await expect(page.getByLabel('Legenda')).toHaveValue(
    'Legenda antes da falha',
  );
  await expect(
    page.getByRole('button', { name: 'Enviar anexo', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Atualizar validação', exact: true }),
  ).toBeEnabled();
  expect(uploads).toHaveLength(1);
  expect(sends).toHaveLength(0);
});
