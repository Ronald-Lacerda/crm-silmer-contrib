import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { OFF_HOURS_NOW } from './support/inbox-vez-fixtures.js';
import { installMocks } from './support/inbox-vez-mock.js';

// RFC 052 round 2 (INBOX-VEZ): P1-A..E and decisions D1..D10 against the
// simulated API. Synthetic data only.
test.use({
  locale: 'pt-BR',
  timezoneId: 'America/Sao_Paulo',
  // @ts-ignore reducedMotion exists at runtime
  reducedMotion: 'reduce',
});

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').BrowserContext} context
 * @param {string} path
 * @param {Record<string, any>} [options] installMocks options
 * @param {{ready?: string|null, store?: Record<string, string>, origin?: string}} [extra]
 */
async function open(page, context, path, options = {}, extra = {}) {
  /** @type {{writes: Array<{method: string, path: string, body: any}>, unmocked: string[]}} */
  const log = { writes: [], unmocked: [] };
  if (extra.origin)
    await context.addCookies([
      { name: 'crm_csrf', value: 'synthetic-csrf', url: extra.origin },
    ]);
  if (extra.store)
    await context.addInitScript((entries) => {
      try {
        for (const [key, value] of Object.entries(entries))
          globalThis.localStorage.setItem(key, value);
      } catch {
        // ignore
      }
    }, extra.store);
  await installMocks(page, log, options);
  await page.goto(path);
  if (extra.ready !== null)
    await page
      .locator(extra.ready ?? '.conversation-row')
      .first()
      .waitFor();
  return log;
}

/** @param {import('@playwright/test').Page} page @param {string} id */
const row = (page, id) =>
  page.locator(`.conversation-row[data-conversation-id="${id}"]`);

const activeId = (/** @type {import('@playwright/test').Page} */ page) =>
  page.evaluate(
    () =>
      globalThis.document.activeElement?.id ??
      globalThis.document.activeElement?.tagName,
  );

test.beforeEach(async ({ context, baseURL }) => {
  await context.addCookies([
    {
      name: 'crm_csrf',
      value: 'synthetic-csrf',
      url: baseURL ?? 'http://127.0.0.1:4391',
    },
  ]);
});

test('P1-A: o tempo do card cruza 15 para 16 min sem nova chamada à lista', async ({
  page,
  context,
}) => {
  const lists = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/v1/inbox/conversations'
    )
      lists.push(request.url());
  });
  // Fake timers first; the mock then fixes Date to 14:30 (turnAsOf).
  await page.clock.install({ time: new Date('2026-11-06T17:30:00.000Z') });
  await open(page, context, '/inbox');
  const time = row(page, 'r-joao').locator('.conv-waiting');
  await expect(time).toBeVisible();
  await expect(time).toContainText('15 min');
  await expect(time).not.toHaveAttribute('data-tone', 'warning');
  const before = lists.length;
  expect(before).toBeGreaterThan(0);
  // One business minute later, still no new answer from the API.
  await page.clock.setFixedTime(new Date('2026-11-06T17:31:30.000Z'));
  await page.clock.runFor(31_000);
  await expect(time).toHaveAttribute('data-tone', 'warning');
  await expect(time).toContainText('16 min');
  expect(lists.length).toBe(before);
});

test('P1-B: em Perdidos o motivo é selo visível, sem title; em Sem retorno o lembrete aparece', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox?aba=perdidos', { extras: true });
  const card = row(page, 'v-perdido-selos');
  await expect(card).toBeVisible();
  const shown = card.locator('.conv-badges .badge:not([data-overflow])');
  await expect(shown.first()).toHaveText(/Perdido · Concorrente/u);
  expect(await shown.count()).toBeLessThanOrEqual(2);
  await expect(
    card.locator('.conv-badges .badge[data-overflow="true"]'),
  ).toBeVisible();
  expect(
    await page.locator('.conv-badges [title], .conv-badges[title]').count(),
  ).toBe(0);
  expect(await card.locator('.badge[title]').count()).toBe(0);

  await page.getByRole('tab', { name: /^Sem retorno/u }).click();
  const other = row(page, 'v-lembrete-outro');
  await expect(other).toBeVisible();
  await expect(
    other.locator('.conv-badges .badge:not([data-overflow])').first(),
  ).toContainText('Lembrete');
  expect(await page.locator('.conv-badges [title]').count()).toBe(0);
});

test('P1-C: conversa fora da página 1 mostra a faixa correta', async ({
  page,
  context,
}) => {
  await open(
    page,
    context,
    '/inbox/v-fora-silencio?aba=sem-retorno',
    { extras: true, bulk: true },
    { ready: '.inbox-turn-notice' },
  );
  await expect(row(page, 'v-fora-silencio')).toHaveCount(0);
  const strip = page.locator('.inbox-turn-notice[role="group"]');
  await expect(strip.locator('#inbox-turn-notice-text')).toContainText(
    /Cliente sem responder há/u,
  );
  await expect(
    strip.getByRole('button', { name: 'Lembrar depois' }),
  ).toBeVisible();
  await expect(
    strip.getByRole('button', { name: 'Marcar perdido' }),
  ).toBeVisible();

  await open(
    page,
    context,
    '/inbox/v-fora-perdido?aba=perdidos',
    { extras: true, bulk: true },
    { ready: '.inbox-turn-notice' },
  );
  await expect(row(page, 'v-fora-perdido')).toHaveCount(0);
  const lost = page.locator('.inbox-turn-notice[role="group"]');
  await expect(lost.locator('#inbox-turn-notice-text')).toContainText(
    /Marcada como perdida · Prazo/u,
  );
  await expect(lost.getByRole('button', { name: 'Reabrir' })).toBeVisible();
});

test('P1-D: API antiga mostra erro em vez da mesma lista nas abas', async ({
  page,
  context,
}) => {
  await open(
    page,
    context,
    '/inbox',
    { legacyApi: true },
    { ready: '.inbox-list-error' },
  );
  for (const name of ['Responder', 'Aguardando', 'Sem retorno', 'Perdidos']) {
    await page.getByRole('tab', { name: new RegExp(`^${name}`, 'u') }).click();
    await expect(
      page.locator('.inbox-list-error p[role="alert"]'),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Tentar de novo' }),
    ).toBeVisible();
    await expect(page.locator('.conversation-row')).toHaveCount(0);
  }
});

test('P1-E: depois de Marcar perdido, Corrigir perda e Lembrar depois o foco fica no título', async ({
  page,
  context,
}) => {
  await open(
    page,
    context,
    '/inbox/s-wanda?aba=sem-retorno',
    {},
    { ready: '.inbox-turn-notice' },
  );
  const title = page.locator('h2#conversation-s-wanda');
  const focusIsTitle = async () => {
    await expect(page).toHaveURL(/\/inbox\/s-wanda/u);
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute('tabindex', '-1');
    await expect.poll(() => activeId(page)).toBe('conversation-s-wanda');
  };

  // Marcar perdido.
  await page
    .getByRole('button', { name: 'Marcar perdido', exact: true })
    .click();
  const lostDialog = page.locator('dialog.lost-dialog[open]');
  await lostDialog.getByLabel('Preço', { exact: true }).check();
  await lostDialog
    .getByRole('button', { name: 'Marcar perdido', exact: true })
    .click();
  await expect(lostDialog).toHaveCount(0);
  await focusIsTitle();
  expect(await activeId(page)).not.toBe('BODY');

  // Corrigir perda (a mesma conversa acaba de ficar perdida).
  await page.getByRole('button', { name: 'Reabrir', exact: true }).click();
  const reopenDialog = page.locator('dialog.reopen-dialog[open]');
  await reopenDialog
    .getByRole('button', { name: 'Corrigir perda', exact: true })
    .click();
  await expect(reopenDialog).toHaveCount(0);
  await focusIsTitle();

  // Lembrar depois (reaberta, volta a Sem retorno).
  await page
    .getByRole('button', { name: 'Lembrar depois', exact: true })
    .click();
  await page
    .locator('#inbox-reminder-form')
    .getByRole('button', { name: 'Salvar lembrete' })
    .click();
  await expect(page.locator('#inbox-reminder-form')).toHaveCount(0);
  await focusIsTitle();
});

test('D9: Reabrir abre diálogo; Cancelar e Esc não chamam o comando e devolvem o foco', async ({
  page,
  context,
}) => {
  // Real clock: Vue drops keyboard events stamped with a frozen clock.
  const log = await open(
    page,
    context,
    '/inbox/l-alice?aba=perdidos',
    { fixedClock: false },
    { ready: '.inbox-turn-notice' },
  );
  const reopen = page.getByRole('button', { name: 'Reabrir', exact: true });
  const dialog = page.locator('dialog.reopen-dialog');
  const focusOnReopen = () =>
    page.evaluate(() => globalThis.document.activeElement?.textContent?.trim());

  await reopen.click();
  await expect(dialog).toHaveAttribute('open', '');
  await expect(dialog.locator('#reopen-dialog-title')).toHaveText(
    /Corrigir perda/u,
  );
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(dialog).not.toHaveAttribute('open', '');
  await expect.poll(focusOnReopen).toBe('Reabrir');

  await reopen.click();
  await expect(dialog).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toHaveAttribute('open', '');
  await expect.poll(focusOnReopen).toBe('Reabrir');

  expect(log.writes).toEqual([]);
});

test.describe('D1/D10: atalhos antigos', () => {
  const seedMine = { store: { 'crm.inbox.owner': 'mine' } };
  /** @param {import('@playwright/test').Page} page */
  const selectedTab = (page) =>
    page
      .locator('[role="tab"][aria-selected="true"] .inbox-tab-label')
      .innerText();

  test('situacao=atender abre Responder com Todos', async ({
    page,
    context,
  }) => {
    await open(page, context, '/inbox?situacao=atender', {}, seedMine);
    expect(await selectedTab(page)).toBe('Responder');
    await page.getByRole('button', { name: 'Filtros', exact: true }).click();
    await expect(
      page.locator('.filter-sheet[open]').getByLabel('Todos', { exact: true }),
    ).toBeChecked();
  });

  test('sanidade: sem atalho a preferência guardada (Minhas) vale', async ({
    page,
    context,
  }) => {
    await open(page, context, '/inbox', {}, seedMine);
    await page.getByRole('button', { name: 'Filtros', exact: true }).click();
    await expect(
      page.locator('.filter-sheet[open]').getByLabel('Minhas', { exact: true }),
    ).toBeChecked();
  });

  test('situacao=agente abre Aguardando', async ({ page, context }) => {
    await open(page, context, '/inbox?situacao=agente');
    expect(await selectedTab(page)).toBe('Aguardando');
  });

  test('situacao=aguardando abre Responder', async ({ page, context }) => {
    await open(page, context, '/inbox?situacao=aguardando');
    expect(await selectedTab(page)).toBe('Responder');
  });
});

test('D1: aplicar outro filtro numa URL de atalho não reescreve a preferência de responsável', async ({
  page,
  context,
}) => {
  await open(
    page,
    context,
    '/inbox?situacao=atender',
    {},
    { store: { 'crm.inbox.owner': 'mine' } },
  );
  const stored = () =>
    page.evaluate(() => globalThis.localStorage.getItem('crm.inbox.owner'));
  expect(await stored()).toBe('mine');
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  const sheet = page.locator('.filter-sheet[open]');
  await expect(sheet.getByLabel('Todos', { exact: true })).toBeChecked();
  await sheet.getByLabel('Só pedidos prontos').check();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
  await expect(page.locator('.filter-sheet[open]')).toHaveCount(0);
  expect(await stored()).toBe('mine');

  // Choosing a responsible in the sheet is a real change and is remembered.
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await page
    .locator('.filter-sheet[open]')
    .getByLabel('Minhas', { exact: true })
    .check();
  await page
    .locator('.filter-sheet[open]')
    .getByRole('button', { name: 'Ver resultados' })
    .click();
  expect(await stored()).toBe('mine');
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  await page
    .locator('.filter-sheet[open]')
    .getByLabel('Todos', { exact: true })
    .check();
  await page
    .locator('.filter-sheet[open]')
    .getByRole('button', { name: 'Ver resultados' })
    .click();
  expect(await stored()).toBe('all');
});

test('alerta de 15 min também chega ao leitor de tela, sem depender da cor', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox', { extras: true });
  const alerted = row(page, 'v-dias').locator('.conv-waiting');
  await expect(alerted).toHaveAttribute('data-tone', 'warning');
  await expect(alerted.locator('.sr-only')).toContainText(
    'Prazo de 15 minutos excedido',
  );
  const calm = row(page, 'r-joao').locator('.conv-waiting');
  await expect(calm).not.toHaveAttribute('data-tone', 'warning');
  await expect(calm.locator('.sr-only')).not.toContainText(
    'Prazo de 15 minutos excedido',
  );
});

test('trocar a conversa com o diálogo aberto fecha o diálogo e não envia o comando a outra', async ({
  page,
}) => {
  /** @type {{writes: Array<{method: string, path: string, body: any}>, unmocked: string[]}} */
  const log = { writes: [], unmocked: [] };
  await installMocks(page, log, { extras: true });
  // Keep the mock's EventSource instances so the test can push a live event.
  await page.addInitScript(() => {
    const scope = /** @type {any} */ (globalThis);
    const Base = scope.EventSource;
    /** @type {any[]} */
    const sources = [];
    scope.__sources = sources;
    scope.EventSource = class extends Base {
      /** @param {...any} args */
      constructor(...args) {
        super(...args);
        sources.push(this);
      }
    };
  });
  await page.goto('/inbox?aba=sem-retorno');
  await page.locator('.conversation-row').first().waitFor();
  const heading = page.locator('h2[tabindex="-1"][id^="conversation-"]');
  await expect(heading).toBeVisible();
  const first = await heading.getAttribute('id');

  await page
    .getByRole('button', { name: 'Marcar perdido', exact: true })
    .click();
  const dialog = page.locator('dialog.lost-dialog[open]');
  await dialog.getByLabel('Preço', { exact: true }).check();

  // Another session snoozes the open conversation; the live refresh then moves
  // the selection to a different one while the dialog is still open.
  const openId = (first ?? '').replace('conversation-', '');
  await page.evaluate(async (id) => {
    await globalThis.fetch(`/api/v1/conversations/${id}/reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remindAt: '2026-12-01T12:00:00.000Z',
        expectedVersion: 3,
      }),
    });
    const source = /** @type {any} */ (globalThis).__sources.at(-1);
    source.dispatchEvent(
      new globalThis.MessageEvent('inbox.conversation.changed', { data: '{}' }),
    );
  }, openId);

  await expect(heading).not.toHaveAttribute('id', first ?? '');
  await expect(page.locator('dialog.lost-dialog[open]')).toHaveCount(0);
  expect(
    log.writes.filter((write) => write.path.endsWith('/lead-outcome')),
  ).toEqual([]);
});

test('D2: lembrete é por pessoa', async ({ page, context }) => {
  await open(page, context, '/inbox?aba=aguardando', { extras: true });
  await expect(row(page, 'v-lembrete-meu')).toBeVisible();
  await page.getByRole('tab', { name: /^Sem retorno/u }).click();
  await expect(row(page, 'v-lembrete-outro')).toBeVisible();
  await expect(row(page, 'v-lembrete-meu')).toHaveCount(0);
  await expect(
    row(page, 'v-lembrete-outro').locator('.conv-badges'),
  ).toContainText('Lembrete');
});

test('D3 e D4: fora do expediente nunca vira "0 min"; dias mantêm o alerta', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox', { extras: true, now: OFF_HOURS_NOW });
  const off = row(page, 'v-foraexp').locator('.conv-waiting');
  await expect(off).toContainText(/fora do expediente/iu);
  expect((await off.textContent()) ?? '').not.toMatch(/(^|\D)0 min/u);

  await open(page, context, '/inbox', { extras: true });
  const days = row(page, 'v-dias').locator('.conv-waiting');
  await expect(days).toContainText(/2 d/u);
  await expect(days).toHaveAttribute('data-tone', 'warning');
});

for (const size of [
  { width: 390, height: 844 },
  { width: 320, height: 640 },
]) {
  test(`D6: celular ${size.width} px, Filtros na linha da busca, abas 2x2`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      viewport: size,
      hasTouch: true,
      isMobile: true,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await open(page, context, '/inbox', {}, { origin: baseURL });
    const filters = page.locator(
      '.inbox-search-row #inbox-filters-slot > button.inbox-filters-button',
    );
    await expect(filters).toBeVisible();
    const search = page.locator('#inbox-search');
    const geometry = /** @type {any} */ (
      await page.evaluate(() => {
        const box = (/** @type {Element|null} */ el) => {
          const r = el?.getBoundingClientRect();
          return r && { top: r.top, height: r.height, left: r.left };
        };
        const tabs = [
          ...globalThis.document.querySelectorAll('[role="tab"]'),
        ].map(box);
        return {
          filters: box(
            globalThis.document.querySelector('.inbox-filters-button'),
          ),
          search: box(globalThis.document.querySelector('#inbox-search')),
          row: box(globalThis.document.querySelector('.conversation-row')),
          tabs,
          scrolls:
            globalThis.document.documentElement.scrollWidth >
            globalThis.document.documentElement.clientWidth,
        };
      })
    );
    void search;
    expect(
      Math.abs(geometry.filters.top - geometry.search.top),
    ).toBeLessThanOrEqual(12);
    expect(geometry.tabs).toHaveLength(4);
    expect(
      new Set(
        geometry.tabs.map((/** @type {any} */ tab) => Math.round(tab.top)),
      ).size,
    ).toBe(2);
    expect(
      new Set(
        geometry.tabs.map((/** @type {any} */ tab) => Math.round(tab.left)),
      ).size,
    ).toBe(2);
    expect(geometry.scrolls).toBe(false);
    for (const tab of geometry.tabs)
      expect(tab.height).toBeGreaterThanOrEqual(44);
    expect(geometry.filters.height).toBeGreaterThanOrEqual(44);
    expect(geometry.search.height).toBeGreaterThanOrEqual(44);
    expect(geometry.row.height).toBeGreaterThanOrEqual(44);
    await context.close();
  });
}

test('D8: transferência pendente sem dono mostra o selo Assumir', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox', { extras: true });
  const badge = row(page, 'v-assumir').locator('.conv-badges .badge', {
    hasText: 'Assumir',
  });
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('data-tone', 'warning');
});

test.describe('axe', () => {
  const tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
  /** @param {import('@playwright/test').Page} page @param {string} [include] */
  async function violations(page, include) {
    let builder = new AxeBuilder({ page }).withTags(tags);
    if (include) builder = builder.include(include);
    const result = await builder.analyze();
    return result.violations.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 4)
          .join(' | ')}`,
    );
  }

  test('lista', async ({ page, context }) => {
    await open(page, context, '/inbox/r-elisa');
    await page.locator('h2#conversation-r-elisa').waitFor();
    expect(await violations(page)).toEqual([]);
  });

  test('faixa', async ({ page, context }) => {
    await open(
      page,
      context,
      '/inbox/s-wanda?aba=sem-retorno',
      {},
      { ready: '.inbox-turn-notice' },
    );
    expect(await violations(page, '.inbox-turn-notice')).toEqual([]);
    await page
      .getByRole('button', { name: 'Lembrar depois', exact: true })
      .click();
    await page.locator('#inbox-reminder-at').waitFor();
    expect(await violations(page, '.inbox-turn-notice')).toEqual([]);
  });

  test('dialog.reopen-dialog', async ({ page, context }) => {
    await open(
      page,
      context,
      '/inbox/l-alice?aba=perdidos',
      {},
      { ready: '.inbox-turn-notice' },
    );
    await page.getByRole('button', { name: 'Reabrir', exact: true }).click();
    await page.locator('dialog.reopen-dialog[open]').waitFor();
    expect(await violations(page, 'dialog.reopen-dialog')).toEqual([]);
  });
});

// Contract audit (A1-A6): the screen against what the real API accepts.
const markLost = (/** @type {import('@playwright/test').Page} */ page) =>
  page.getByRole('button', { name: 'Marcar perdido', exact: true });

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} reason
 */
async function submitLoss(page, reason = 'Preço') {
  await markLost(page).click();
  const dialog = page.locator('dialog.lost-dialog[open]');
  await dialog.getByLabel(reason, { exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Marcar perdido', exact: true })
    .click();
  return dialog;
}

test.describe('A1: versão do desfecho', () => {
  for (const scene of [
    { id: 's-sabrina', outcomeVersion: 0, why: 'nunca teve desfecho' },
    { id: 'v-reaberta', outcomeVersion: 2, why: 'perda já reaberta' },
  ]) {
    test(`Marcar perdido envia a versão lida da API (${scene.why})`, async ({
      page,
      context,
    }) => {
      const reads = [];
      page.on('request', (request) => {
        if (
          request.method() === 'GET' &&
          request.url().endsWith(`/conversations/${scene.id}/lead-outcome`)
        )
          reads.push(request.url());
      });
      const log = await open(
        page,
        context,
        `/inbox/${scene.id}?aba=sem-retorno`,
        { extras: true },
        { ready: '.inbox-turn-notice' },
      );
      const dialog = await submitLoss(page);
      await expect(dialog).toHaveCount(0);
      expect(reads.length).toBeGreaterThan(0);
      const write = log.writes.find((item) =>
        item.path.endsWith('/lead-outcome'),
      );
      expect(write?.body).toMatchObject({
        outcome: 'lost',
        reasonCode: 'preco',
        expectedConversationVersion: 3,
        expectedOutcomeVersion: scene.outcomeVersion,
      });
      // Accepted by the simulated API: the conversation is now in Perdidos
      // and the focus is on its title.
      await expect(page.locator('#inbox-turn-notice-text')).toContainText(
        /Marcada como perdida · Preço/u,
      );
      await expect.poll(() => activeId(page)).toBe(`conversation-${scene.id}`);
    });
  }

  test('sem poder ler a versão o comando não é enviado', async ({
    page,
    context,
  }) => {
    const log = await open(
      page,
      context,
      '/inbox/s-sabrina?aba=sem-retorno',
      { extras: true },
      { ready: '.inbox-turn-notice' },
    );
    await page.route('**/conversations/s-sabrina/lead-outcome', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE' } })
        : route.fallback(),
    );
    const dialog = await submitLoss(page);
    await expect(dialog.locator('p[role="alert"]')).toContainText(
      /Não foi possível conferir/u,
    );
    expect(
      log.writes.filter((write) => write.path.endsWith('/lead-outcome')),
    ).toEqual([]);
  });

  test('Reabrir envia a versão do desfecho ativo', async ({
    page,
    context,
  }) => {
    const log = await open(
      page,
      context,
      '/inbox/l-alice?aba=perdidos',
      {},
      { ready: '.inbox-turn-notice' },
    );
    await page.getByRole('button', { name: 'Reabrir', exact: true }).click();
    await page
      .locator('dialog.reopen-dialog[open]')
      .getByRole('button', { name: 'Corrigir perda', exact: true })
      .click();
    await expect(page.locator('dialog.reopen-dialog[open]')).toHaveCount(0);
    expect(
      log.writes.find((write) => write.path.endsWith('/lead-outcome'))?.body,
    ).toMatchObject({
      outcome: 'reopened',
      expectedConversationVersion: 3,
      expectedOutcomeVersion: 1,
    });
  });
});

test('A2: Arquivadas e Encerradas nunca enviam orderReady e desligam "Só pedidos prontos"', async ({
  page,
  context,
}) => {
  /** @type {URL[]} */
  const lists = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v1/inbox/conversations') lists.push(url);
  });
  await open(page, context, '/inbox?situacao=fechar');
  expect(lists.at(-1)?.searchParams.get('orderReady')).toBe('true');
  for (const consult of ['Arquivadas', 'Encerradas']) {
    await page.getByRole('button', { name: 'Filtros', exact: true }).click();
    const sheet = page.locator('.filter-sheet[open]');
    const ready = sheet.getByLabel('Só pedidos prontos');
    await sheet.getByLabel('Em andamento (abas)').check();
    await ready.check();
    await sheet.getByLabel(consult, { exact: true }).check();
    await expect(ready).toBeDisabled();
    await expect(ready).not.toBeChecked();
    await expect(sheet).toContainText(/Vale só para conversas em andamento/u);
    const before = lists.length;
    await sheet.getByRole('button', { name: 'Ver resultados' }).click();
    await expect.poll(() => lists.length).toBeGreaterThan(before);
    for (const url of lists.slice(before)) {
      expect(url.searchParams.has('bucket')).toBe(false);
      expect(url.searchParams.has('orderReady')).toBe(false);
    }
    await expect(page.locator('.inbox-list-error')).toHaveCount(0);
  }
});

test.describe('A3: ação só quando permitida, com motivo em texto', () => {
  /**
   * @param {import('@playwright/test').Page} page
   * @param {import('@playwright/test').BrowserContext} context
   * @param {string} id
   * @param {Record<string, any>} [options]
   */
  function silentStrip(page, context, id, options = {}) {
    return open(
      page,
      context,
      `/inbox/${id}?aba=sem-retorno`,
      { extras: true, ...options },
      { ready: '.inbox-turn-notice' },
    );
  }

  for (const scene of [
    { id: 's-tiago', reason: /Só quem atende a conversa ou um administrador/u },
    { id: 's-xavier', reason: /atendimento humano/u },
    { id: 's-zeca', reason: /Assuma a conversa/u },
    { id: 's-vitor', reason: /Há pedido em aberto/u },
  ]) {
    test(`${scene.id}: Marcar perdido desabilitado com o motivo`, async ({
      page,
      context,
    }) => {
      const log = await silentStrip(page, context, scene.id);
      const button = markLost(page);
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAttribute(
        'aria-describedby',
        'inbox-outcome-reason',
      );
      await expect(page.locator('#inbox-outcome-reason')).toBeVisible();
      await expect(page.locator('#inbox-outcome-reason')).toContainText(
        scene.reason,
      );
      await button.click({ force: true });
      await expect(page.locator('dialog.lost-dialog[open]')).toHaveCount(0);
      expect(log.writes).toEqual([]);
    });
  }

  test('quem não é dono ainda pode lembrar a si mesmo', async ({
    page,
    context,
  }) => {
    const log = await silentStrip(page, context, 's-tiago');
    await page
      .getByRole('button', { name: 'Lembrar depois', exact: true })
      .click();
    await page
      .locator('#inbox-reminder-form')
      .getByRole('button', { name: 'Salvar lembrete' })
      .click();
    await expect(page.locator('#inbox-reminder-form')).toHaveCount(0);
    expect(
      log.writes.filter((write) => write.path.endsWith('/reminder')),
    ).toHaveLength(1);
  });

  test('administrador marca a perda de conversa de outro vendedor', async ({
    page,
    context,
  }) => {
    const log = await silentStrip(page, context, 's-tiago', { admin: true });
    await expect(markLost(page)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#inbox-outcome-reason')).toHaveCount(0);
    await submitLoss(page);
    expect(
      log.writes.find((write) => write.path.endsWith('/lead-outcome'))?.body,
    ).toMatchObject({ outcome: 'lost', expectedOutcomeVersion: 0 });
  });

  test('Perdidos: Reabrir de outro vendedor fica desabilitado com o motivo', async ({
    page,
    context,
  }) => {
    const log = await open(
      page,
      context,
      '/inbox/l-celia?aba=perdidos',
      {},
      { ready: '.inbox-turn-notice' },
    );
    const reopen = page.getByRole('button', { name: 'Reabrir', exact: true });
    await expect(reopen).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#inbox-outcome-reason')).toContainText(
      /Só quem atende a conversa ou um administrador/u,
    );
    await reopen.click({ force: true });
    await expect(page.locator('dialog.reopen-dialog[open]')).toHaveCount(0);
    expect(log.writes).toEqual([]);
  });
});

test.describe('A4: recusas da API em português', () => {
  const refusals = [
    {
      status: 409,
      code: 'LEAD_HAS_ORDER',
      text: /Há pedido em aberto; encerre ou cancele o pedido antes/u,
    },
    {
      status: 409,
      code: 'LEAD_AWAITING_REPLY',
      text: /O cliente espera resposta/u,
    },
    {
      status: 409,
      code: 'LEAD_NOT_ELIGIBLE',
      text: /Só conversas com atendimento humano e dono/u,
    },
    {
      status: 409,
      code: 'LEAD_ALREADY_LOST',
      text: /já está marcada como perdida/u,
    },
    {
      status: 409,
      code: 'VERSION_CONFLICT',
      text: /A conversa mudou enquanto você trabalhava/u,
    },
    {
      status: 403,
      code: 'FORBIDDEN',
      text: /Só o dono da conversa ou um administrador pode marcar/u,
    },
  ];
  for (const refusal of refusals) {
    test(`${refusal.status} ${refusal.code}`, async ({ page, context }) => {
      await open(
        page,
        context,
        '/inbox/s-sabrina?aba=sem-retorno',
        {
          commandErrors: {
            'lead-outcome': { status: refusal.status, code: refusal.code },
          },
        },
        { ready: '.inbox-turn-notice' },
      );
      const dialog = await submitLoss(page);
      // The dialog is void after a refusal; the reason stays in the pane and
      // the focus on the conversation title.
      await expect(dialog).toHaveCount(0);
      await expect(
        page.locator('.inbox-pane-notices p[role="alert"]'),
      ).toContainText(refusal.text);
      await expect.poll(() => activeId(page)).toBe('conversation-s-sabrina');
      await expect(page.locator('h2#conversation-s-sabrina')).toBeVisible();
    });
  }

  test('422 INVALID_LOSS_NOTE mantém o diálogo aberto com a mensagem', async ({
    page,
    context,
  }) => {
    await open(
      page,
      context,
      '/inbox/s-sabrina?aba=sem-retorno',
      {
        commandErrors: {
          'lead-outcome': { status: 422, code: 'INVALID_LOSS_NOTE' },
        },
      },
      { ready: '.inbox-turn-notice' },
    );
    await markLost(page).click();
    const dialog = page.locator('dialog.lost-dialog[open]');
    await dialog.getByLabel('Outro', { exact: true }).check();
    await dialog.getByLabel('Detalhe').fill('Sem verba neste mês');
    await dialog
      .getByRole('button', { name: 'Marcar perdido', exact: true })
      .click();
    await expect(dialog.locator('p[role="alert"]')).toContainText(
      /até 140 caracteres, com texto legível/u,
    );
    await expect(dialog).toBeVisible();
  });

  test('lembrete: INVALID_REMINDER_DATE fica junto do campo', async ({
    page,
    context,
  }) => {
    await open(
      page,
      context,
      '/inbox/s-sabrina?aba=sem-retorno',
      {
        commandErrors: {
          reminder: { status: 422, code: 'INVALID_REMINDER_DATE' },
        },
      },
      { ready: '.inbox-turn-notice' },
    );
    await page
      .getByRole('button', { name: 'Lembrar depois', exact: true })
      .click();
    const form = page.locator('#inbox-reminder-form');
    await form.getByRole('button', { name: 'Salvar lembrete' }).click();
    await expect(form.locator('#inbox-reminder-error')).toContainText(
      /futuro, em até 90 dias/u,
    );
    await expect(form.locator('#inbox-reminder-at')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await expect.poll(() => activeId(page)).toBe('inbox-reminder-at');
  });

  test('lembrete: ACTION_NOT_AVAILABLE mostra a recusa e recarrega', async ({
    page,
    context,
  }) => {
    await open(
      page,
      context,
      '/inbox/s-sabrina?aba=sem-retorno',
      {
        commandErrors: {
          reminder: { status: 409, code: 'ACTION_NOT_AVAILABLE' },
        },
      },
      { ready: '.inbox-turn-notice' },
    );
    await page
      .getByRole('button', { name: 'Lembrar depois', exact: true })
      .click();
    const form = page.locator('#inbox-reminder-form');
    await form.getByRole('button', { name: 'Salvar lembrete' }).click();
    await expect(page.locator('p[role="alert"]').first()).toContainText(
      /não aceita lembrete/u,
    );
  });
});

test('A5: o campo do lembrete limita a 90 dias e recusa além disso sem chamar a API', async ({
  page,
  context,
}) => {
  const log = await open(
    page,
    context,
    '/inbox/s-sabrina?aba=sem-retorno',
    {},
    { ready: '.inbox-turn-notice' },
  );
  await page
    .getByRole('button', { name: 'Lembrar depois', exact: true })
    .click();
  const field = page.locator('#inbox-reminder-at');
  // Fixed clock: Fri 2026-11-06 14:30 in São Paulo.
  await expect(field).toHaveAttribute('min', '2026-11-06T14:30');
  await expect(field).toHaveAttribute('max', '2027-02-04T14:29');
  const form = page.locator('#inbox-reminder-form');
  await field.fill('2027-02-10T09:00');
  await form.getByRole('button', { name: 'Salvar lembrete' }).click();
  await expect(form.locator('#inbox-reminder-error')).toContainText(
    /em até 90 dias/u,
  );
  expect(log.writes).toEqual([]);
  await field.fill('2027-02-03T09:00');
  await form.getByRole('button', { name: 'Salvar lembrete' }).click();
  await expect(form).toHaveCount(0);
  expect(log.writes).toHaveLength(1);
  expect(log.writes[0].body.expectedVersion).toBe(3);
});

test.describe('A6: atualização periódica de abas e contadores', () => {
  /** @param {import('@playwright/test').Page} page */
  function watchReads(page) {
    const reads = { lists: 0, buckets: 0 };
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (request.method() !== 'GET') return;
      if (pathname === '/api/v1/inbox/conversations') reads.lists += 1;
      if (pathname === '/api/v1/inbox/buckets') reads.buckets += 1;
    });
    return reads;
  }

  test('a cada 60 s, com a aba visível, sem tirar o foco', async ({
    page,
    context,
  }) => {
    const reads = watchReads(page);
    await page.clock.install({ time: new Date('2026-11-06T17:30:00.000Z') });
    await open(page, context, '/inbox');
    const search = page.locator('#inbox-search');
    await search.focus();
    const lists = reads.lists;
    const buckets = reads.buckets;
    await page.clock.runFor(30_000);
    expect(reads.lists).toBe(lists);
    await page.clock.runFor(31_000);
    await expect.poll(() => reads.lists).toBeGreaterThan(lists);
    await expect.poll(() => reads.buckets).toBeGreaterThan(buckets);
    await expect.poll(() => activeId(page)).toBe('inbox-search');
  });

  test('com o navegador em segundo plano nada é lido', async ({
    page,
    context,
  }) => {
    const reads = watchReads(page);
    await page.clock.install({ time: new Date('2026-11-06T17:30:00.000Z') });
    await open(page, context, '/inbox');
    await page.evaluate(() => {
      Object.defineProperty(globalThis.document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
    });
    const lists = reads.lists;
    const buckets = reads.buckets;
    await page.clock.runFor(130_000);
    expect(reads.lists).toBe(lists);
    expect(reads.buckets).toBe(buckets);
    // Back in the foreground, the next minute reads again.
    await page.evaluate(() => {
      Object.defineProperty(globalThis.document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
    });
    await page.clock.runFor(61_000);
    await expect.poll(() => reads.lists).toBeGreaterThan(lists);
  });
});

// Independent review (items 1-8): races, scope changes, work in progress and
// the tests that went missing with the old shortcuts.

/** Keeps the mock's EventSource instances so a test can push a live event. */
async function keepEventSources(
  /** @type {import('@playwright/test').Page} */ page,
) {
  await page.addInitScript(() => {
    const scope = /** @type {any} */ (globalThis);
    const Base = scope.EventSource;
    /** @type {any[]} */
    const sources = [];
    scope.__sources = sources;
    scope.EventSource = class extends Base {
      /** @param {...any} args */
      constructor(...args) {
        super(...args);
        sources.push(this);
      }
    };
  });
}

/**
 * Another session snoozes the conversation; the live refresh then reads the
 * lists again, and Sem retorno no longer holds it.
 *
 * @param {import('@playwright/test').Page} page @param {string} id
 */
function snoozeElsewhere(page, id) {
  return page.evaluate(async (conversationId) => {
    await globalThis.fetch(`/api/v1/conversations/${conversationId}/reminder`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        remindAt: '2026-12-01T12:00:00.000Z',
        expectedVersion: 3,
      }),
    });
    const source = /** @type {any} */ (globalThis).__sources.at(-1);
    source.dispatchEvent(
      new globalThis.MessageEvent('inbox.conversation.changed', { data: '{}' }),
    );
  }, id);
}

test('1: a seleção muda durante a leitura da versão e nenhum POST sai', async ({
  page,
}) => {
  /** @type {{writes: Array<{method: string, path: string, body: any}>, unmocked: string[]}} */
  const log = { writes: [], unmocked: [] };
  await installMocks(page, log, { extras: true });
  await keepEventSources(page);
  await page.goto('/inbox?aba=sem-retorno');
  await page.locator('.conversation-row').first().waitFor();
  const heading = page.locator('h2[tabindex="-1"][id^="conversation-"]');
  const first = (await heading.getAttribute('id')) ?? '';
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  let reads = 0;
  await page.route('**/conversations/*/lead-outcome', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads += 1;
    // The read at opening fails, so the version is still unknown at submit.
    if (reads === 1)
      return route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } });
    await gate;
    return route.fallback();
  });
  await markLost(page).click();
  const dialog = page.locator('dialog.lost-dialog[open]');
  await expect.poll(() => reads).toBe(1);
  await dialog.getByLabel('Preço', { exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Marcar perdido', exact: true })
    .click();
  await expect.poll(() => reads).toBe(2);
  await snoozeElsewhere(page, first.replace('conversation-', ''));
  await expect(heading).not.toHaveAttribute('id', first);
  release();
  await expect(page.locator('dialog.lost-dialog[open]')).toHaveCount(0);
  expect(
    log.writes.filter((write) => write.path.endsWith('/lead-outcome')),
  ).toEqual([]);
});

test('2: falha da lista depois de trocar de aba não mostra as linhas da aba anterior', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox');
  await expect(row(page, 'r-joao')).toBeVisible();
  await page.route('**/api/v1/inbox/conversations?**', (route) =>
    new URL(route.request().url()).searchParams.get('bucket') === 'awaiting'
      ? route.fulfill({ status: 503, json: { code: 'UNAVAILABLE' } })
      : route.fallback(),
  );
  await page.getByRole('tab', { name: /^Aguardando/u }).click();
  await expect(page.locator('.inbox-list-error p[role="alert"]')).toBeVisible();
  await expect(page.locator('.conversation-row')).toHaveCount(0);
  // A failure is not an empty tab.
  await expect(
    page.getByRole('heading', {
      name: 'Nenhuma conversa aguardando o cliente',
    }),
  ).toHaveCount(0);
  // Changing the scope empties the totals too until they are read again.
  await page.getByRole('button', { name: 'Filtros', exact: true }).click();
  const sheet = page.locator('.filter-sheet[open]');
  await sheet.getByLabel('Minhas', { exact: true }).check();
  await sheet.getByRole('button', { name: 'Ver resultados' }).click();
  await expect(page.locator('.conversation-row')).toHaveCount(0);
});

test('3: o rascunho mantém a conversa aberta mesmo quando ela sai da aba', async ({
  page,
}) => {
  await installMocks(page, { writes: [], unmocked: [] }, { extras: true });
  await keepEventSources(page);
  await page.goto('/inbox?aba=sem-retorno');
  await page.locator('.conversation-row').first().waitFor();
  const heading = page.locator('h2[tabindex="-1"][id^="conversation-"]');
  const first = (await heading.getAttribute('id')) ?? '';
  const reply = page.getByRole('textbox', { name: 'Responder', exact: true });
  await reply.fill('Rascunho sintético a preservar');
  await snoozeElsewhere(page, first.replace('conversation-', ''));
  await expect(row(page, first.replace('conversation-', ''))).toHaveCount(0);
  await expect(heading).toHaveAttribute('id', first);
  await expect(reply).toHaveValue('Rascunho sintético a preservar');
});

test('3: depois de enviar, a conversa e a confirmação continuam na tela', async ({
  page,
  context,
}) => {
  const log = await open(page, context, '/inbox');
  const heading = page.locator('h2[tabindex="-1"][id^="conversation-"]');
  await expect(heading).toBeVisible();
  const first = (await heading.getAttribute('id')) ?? '';
  await page
    .getByRole('textbox', { name: 'Responder', exact: true })
    .fill('Resposta sintética');
  await page
    .getByRole('button', { name: 'Enviar resposta', exact: true })
    .click();
  await expect(
    page.getByText('Mensagem aceita para envio.', { exact: true }),
  ).toBeVisible();
  // The conversation left Responder, and still is the one on screen.
  await expect(row(page, first.replace('conversation-', ''))).toHaveCount(0);
  await expect(heading).toHaveAttribute('id', first);
  expect(
    log.writes.filter((write) => write.path.endsWith('/messages')),
  ).toHaveLength(1);
});

test('4: ?aba= e ?fila= desconhecidos, mesmo com nomes de Object.prototype, abrem o padrão', async ({
  page,
  context,
}) => {
  for (const value of ['constructor', '__proto__', 'toString']) {
    await open(page, context, `/inbox?aba=${value}&fila=${value}`);
    await expect(
      page.locator('[role="tab"][aria-selected="true"] .inbox-tab-label'),
    ).toHaveText('Responder');
    await expect(page.locator('.inbox-list-error')).toHaveCount(0);
  }
});

test('5 e 6: o erro aparece uma vez e o diálogo esquece o que foi digitado', async ({
  page,
  context,
}) => {
  await open(
    page,
    context,
    '/inbox/s-sabrina?aba=sem-retorno',
    {
      fixedClock: false,
      commandErrors: {
        'lead-outcome': { status: 422, code: 'INVALID_LOSS_NOTE' },
      },
    },
    { ready: '.inbox-turn-notice' },
  );
  await markLost(page).click();
  const dialog = page.locator('dialog.lost-dialog[open]');
  await dialog.getByLabel('Outro', { exact: true }).check();
  const note = dialog.getByLabel('Detalhe');
  await expect(note).toHaveAttribute('autocomplete', 'off');
  await expect(note).toHaveAttribute('spellcheck', 'false');
  await note.fill('Sem verba neste mês');
  await dialog
    .getByRole('button', { name: 'Marcar perdido', exact: true })
    .click();
  await expect(dialog.locator('p[role="alert"]')).toHaveCount(1);
  await expect(page.locator('.inbox-pane-notices p[role="alert"]')).toHaveCount(
    0,
  );
  // Esc closes it, the focus returns to the button, and nothing is kept.
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.lost-dialog[open]')).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        globalThis.document.activeElement?.textContent?.trim(),
      ),
    )
    .toBe('Marcar perdido');
  await markLost(page).click();
  await expect(dialog.getByLabel('Outro', { exact: true })).not.toBeChecked();
  await expect(dialog.locator('p[role="alert"]')).toHaveCount(0);
  await dialog.getByLabel('Outro', { exact: true }).check();
  await expect(dialog.getByLabel('Detalhe')).toHaveValue('');
});

test('7: a releitura de 60 s espera um diálogo aberto', async ({
  page,
  context,
}) => {
  let lists = 0;
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (
      request.method() === 'GET' &&
      pathname === '/api/v1/inbox/conversations'
    )
      lists += 1;
  });
  await page.clock.install({ time: new Date('2026-11-06T17:30:00.000Z') });
  await open(
    page,
    context,
    '/inbox/s-sabrina?aba=sem-retorno',
    {},
    { ready: '.inbox-turn-notice' },
  );
  await markLost(page).click();
  await expect(page.locator('dialog.lost-dialog[open]')).toHaveCount(1);
  const before = lists;
  await page.clock.runFor(125_000);
  expect(lists).toBe(before);
  await page.evaluate(() =>
    /** @type {HTMLDialogElement} */ (
      globalThis.document.querySelector('dialog.lost-dialog')
    ).close(),
  );
  await page.clock.runFor(61_000);
  await expect.poll(() => lists).toBeGreaterThan(before);
});

test('8a: conversa de outro vendedor mostra o cabeçalho, sem assumir nem enviar', async ({
  page,
  context,
}) => {
  const log = await open(
    page,
    context,
    '/inbox/r-bruno',
    {},
    { ready: '.conv-head' },
  );
  await expect(page.locator('.conv-head')).toContainText('Carlos Lima');
  await expect(
    page.getByRole('button', { name: 'Assumir atendimento', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Enviar resposta', exact: true }),
  ).toBeDisabled();
  expect(log.writes).toEqual([]);
});

test('8b: o tablist responde ao teclado, com tabindex itinerante e foco na lista', async ({
  page,
  context,
}) => {
  // Real clock: Vue drops keyboard events stamped with a frozen clock.
  await open(page, context, '/inbox', { fixedClock: false });
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(4);
  const state = () =>
    page.evaluate(() =>
      [...globalThis.document.querySelectorAll('[role="tab"]')].map((tab) => [
        tab.getAttribute('aria-selected'),
        tab.getAttribute('tabindex'),
      ]),
    );
  expect(await state()).toEqual([
    ['true', '0'],
    ['false', '-1'],
    ['false', '-1'],
    ['false', '-1'],
  ]);
  await tabs.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  expect(await state()).toEqual([
    ['false', '-1'],
    ['true', '0'],
    ['false', '-1'],
    ['false', '-1'],
  ]);
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(3)).toBeFocused();
  await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(tabs.nth(3)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();
  // Enter and click take the focus to the list summary, which announces it.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('.inbox-list-summary')).toBeFocused();
  await tabs.nth(2).click();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.inbox-list-summary')).toBeFocused();
});

test('8c: sem /inbox/buckets as abas dizem "total indisponível"', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox', { failBuckets: true });
  for (const name of [
    'Responder, total indisponível',
    'Aguardando cliente, total indisponível',
    'Sem retorno, total indisponível',
    'Perdidos, total indisponível',
  ])
    await expect(page.getByRole('tab', { name, exact: true })).toBeVisible();
  await expect(page.locator('.inbox-tab-count')).toHaveCount(0);
  // The list itself still loads.
  await expect(row(page, 'r-joao')).toBeVisible();
});

test('8e: Limpar filtros no vazio com filtro, e o chip de PNL-06', async ({
  page,
  context,
}) => {
  await open(page, context, '/inbox?responsavel=seller-carlos');
  const summary = page.getByRole('group', { name: 'Filtro:' });
  await expect(summary.getByText('Conversas de Carlos Lima')).toBeVisible();
  await expect(page.locator('.conversation-row')).toHaveCount(2);
  await expect(row(page, 'r-bruno')).toBeVisible();
  await expect(row(page, 'r-iris')).toBeVisible();

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(
    page,
    context,
    '/inbox?responsavel=seller-carlos&situacao=fechar',
    {},
    { ready: '.empty-list h2' },
  );
  await expect(
    page.getByRole('heading', { name: 'Nenhuma conversa com esse filtro' }),
  ).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const clear = page
    .getByRole('list', { name: 'Conversas' })
    .getByRole('button', { name: 'Limpar filtros', exact: true });
  await clear.focus();
  await page.keyboard.press('Enter');
  await expect(row(page, 'r-joao')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Filtro:' })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Filtros', exact: true }),
  ).toBeFocused();
});

test.describe('8f: os links antigos abrem o estado certo', () => {
  const cases = [
    {
      url: '/inbox?situacao=vendedor',
      tab: 'Responder',
      query: { bucket: 'respond', owner: 'all' },
      chips: [],
    },
    {
      url: '/inbox?situacao=arquivadas',
      tab: null,
      query: { archived: 'true', owner: 'all' },
      chips: ['Arquivadas'],
    },
    {
      url: '/inbox?fila=minhas',
      tab: 'Responder',
      query: { bucket: 'respond', owner: 'mine' },
      chips: ['Minhas'],
    },
    {
      url: '/inbox?fila=sem-responsavel',
      tab: 'Responder',
      query: { bucket: 'respond', owner: 'unassigned' },
      chips: ['Sem dono'],
    },
    {
      url: '/inbox?responsavel=seller-carlos',
      tab: 'Responder',
      query: {
        bucket: 'respond',
        owner: 'all',
        assignedUserId: 'seller-carlos',
      },
      chips: ['Conversas de Carlos Lima'],
    },
  ];
  for (const scene of cases) {
    test(scene.url, async ({ page, context }) => {
      /** @type {Array<Record<string, string>>} */
      const lists = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (
          url.pathname === '/api/v1/inbox/conversations' &&
          url.searchParams.get('limit') !== '1'
        )
          lists.push(Object.fromEntries(url.searchParams));
      });
      await open(page, context, scene.url, {}, { ready: null });
      const summary = page.getByRole('group', { name: 'Filtro:' });
      if (scene.chips.length)
        await expect(
          summary.getByRole('button').filter({ hasText: scene.chips[0] }),
        ).toBeVisible();
      else await expect(summary).toHaveCount(0);
      if (scene.tab)
        await expect(
          page.locator('[role="tab"][aria-selected="true"] .inbox-tab-label'),
        ).toHaveText(scene.tab);
      await expect.poll(() => lists.at(-1)).toMatchObject(scene.query);
      if (scene.url.includes('arquivadas'))
        await expect(row(page, 'x-helena')).toBeVisible();
    });
  }
});

test('P2: no celular, abrir Lembrar depois esconde a barra inferior e cancelar a devolve', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(
    page,
    context,
    '/inbox/s-sabrina?aba=sem-retorno',
    {},
    { ready: '.inbox-turn-notice' },
  );
  const bar = page.locator('.mobile-nav');
  await expect(bar).toBeVisible();
  await page
    .getByRole('button', { name: 'Lembrar depois', exact: true })
    .click();
  // The date field takes the focus; the bar steps aside, as for the composer.
  await expect(page.locator('#inbox-reminder-at')).toBeFocused();
  await expect(bar).toBeHidden();
  await page
    .locator('#inbox-reminder-form')
    .getByRole('button', { name: 'Cancelar' })
    .click();
  await expect(bar).toBeVisible();
});
