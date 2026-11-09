import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockOrders, pendingOrder } from './support/orders-mock.js';

// OLIST-L1 (ADR 069): invalidação administrativa de uma geração que ainda não
// chegou à venda. Tudo sintético e 100% interceptado: nenhuma chamada real,
// nenhum POST de criação. /export e qualquer rota desconhecida falham o teste
// em vez de alcançar uma API real.

const orderId = 'acbf1c1b-c57f-4c5c-8076-7f439f95cfb0';
const exportId = '5b0a1d1e-5a8e-4f55-9a53-2f1b3c0f6e11';
const customerId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const integration = '/api/v1/integrations/olist';
const operationUrl = `/api/v1/orders/${orderId}/olist`;
const canary = 'provider-payload-secret-canary';
const REASON = 'Cliente pediu para refazer a geração do pedido';
const VERSION = 7;
const INVALIDATED = 'OLIST_EXPORT_INVALIDATED';
const SUCCESS_TEXT =
  'Geração invalidada antes de qualquer venda. Cadastros já criados no Olist foram preservados. Gere uma nova prévia.';

/** @param {string} state @param {string} stage @param {Record<string, any>} [extra] */
function op(state, stage, extra = {}) {
  return { state, stage, number: null, ...extra };
}

/** @param {string} id @param {string} kind @param {string} state @param {number} version @param {string|null} remoteId */
function resource(id, kind, state, version, remoteId) {
  return { id, kind, state, version, remoteId, parentId: null };
}

/** Geração pronta para a venda, sem nenhuma tentativa de venda. */
const readyResources = () => [
  resource(customerId, 'customer', 'confirmed', 2, '100'),
  resource(productId, 'product', 'confirmed', 3, '200'),
];
const readyAttempts = () => [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    resourceId: customerId,
    stage: 'customer',
    outcome: 'confirmed',
    observedRemoteId: '100',
    code: null,
    createdAt: '2026-11-08T12:59:00.000Z',
    finishedAt: '2026-11-08T12:59:02.000Z',
  },
];

/**
 * @typedef {{status: number, code: string, commits?: boolean}} Failure
 * @typedef {{
 *   viewer?: 'seller'|'finance'|'admin',
 *   enabled?: boolean,
 *   operation?: any,
 *   resources?: any[],
 *   attempts?: any[],
 *   version?: number,
 *   failures?: Failure[],
 *   gate?: boolean,
 *   liveEvents?: boolean,
 *   order?: Record<string, any>,
 * }} Options
 */

/** @param {import('@playwright/test').Page} page @param {Options} [options] */
async function setup(page, options = {}) {
  const profile = options.viewer ?? 'admin';
  const viewer = {
    id: 'viewer-synthetic',
    name: 'Operador sintético',
    email: 'operador@example.test',
    functionName: profile === 'finance' ? 'Financeiro' : 'Vendedor',
    capabilities: profile === 'admin' ? ['COMMERCIAL_ADMIN'] : [],
    olistEnabled: options.enabled ?? true,
    olistAuthorizationVersion: 2,
  };
  const state = {
    /** @type {any} */ operation:
      options.operation === undefined ? op('ready', 'sale') : options.operation,
    resources: options.resources ?? readyResources(),
    attempts: options.attempts ?? readyAttempts(),
    version: options.version ?? VERSION,
    /** @type {Failure[]} */ failures: [...(options.failures ?? [])],
    /** @type {Array<{path:string,method:string,body:any,key?:string,csrf?:string}>} */
    calls: [],
    /** @type {string[]} */ consoleTexts: [],
    release: () => {},
    viewer,
    /** @type {any} */ order: options.order
      ? JSON.parse(JSON.stringify(options.order))
      : null,
    /** @type {Array<{name:string, data:any}>} */ queue: [],
    /** @type {Array<(event:{name:string, data:any}) => void>} */ waiters: [],
    eventSeq: 0,
    /** @param {string} name @param {any} [data] */
    pushEvent(name, data = {}) {
      const waiter = state.waiters.shift();
      if (waiter) waiter({ name, data });
      else state.queue.push({ name, data });
    },
    /** O servidor grava a invalidação: a operação arquivada fica a mais recente. */
    commit() {
      state.version += 1;
      state.operation = op('invalidated', state.operation?.stage ?? 'sale', {
        errorCode: INVALIDATED,
      });
    },
    diagnostic() {
      return {
        operation: state.operation
          ? {
              id: exportId,
              actorId: 'admin-synthetic',
              version: state.version,
              ...state.operation,
            }
          : null,
        resources: state.resources,
        requests: [],
        attempts: state.attempts,
        attemptHistoryTruncated: false,
      };
    },
  };
  const gate = new Promise((resolve) => {
    state.release = () => resolve(null);
  });
  page.on('console', (message) => state.consoleTexts.push(message.text()));
  page.on('pageerror', (error) =>
    state.consoleTexts.push(`pageerror: ${String(error)}`),
  );
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 'l1-csrf', url: 'http://127.0.0.1:4173' },
    ]);
  if (options.order)
    await mockOrders(page, {
      orders: [JSON.parse(JSON.stringify(options.order))],
    });
  const target = options.order ? page : page.context();
  await target.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = ['POST', 'PATCH'].includes(method) ? req.postDataJSON() : null;
    state.calls.push({
      path,
      method,
      body,
      key: req.headers()['idempotency-key'],
      csrf: req.headers()['x-csrf-token'],
    });
    const json = (/** @type {unknown} */ value, status = 200) =>
      route.fulfill({
        status,
        contentType:
          status >= 400 ? 'application/problem+json' : 'application/json',
        body: JSON.stringify(value),
      });
    if (path === '/api/v1/sessions/current') return json({ user: viewer });
    if (path === '/api/v1/events') {
      if (!options.liveEvents)
        return route.fulfill({
          contentType: 'text/event-stream',
          body: 'retry: 60000\n\n',
        });
      /** @type {{name: string, data: any}} */
      const next =
        state.queue.shift() ??
        (await new Promise((resolve) => state.waiters.push(resolve)));
      state.eventSeq += 1;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `retry: 200\n\nevent: ${next.name}\nid: l1-${state.eventSeq}\ndata: ${JSON.stringify(next.data)}\n\n`,
      });
    }
    if (path === '/api/v1/orders/summary') return json({ storeNewCount: 0 });
    if (options.order && path === `/api/v1/orders/${orderId}`) {
      if (method === 'GET') return json({ order: state.order });
    }
    if (path === '/api/v1/finance/orders')
      return json({
        items: [],
        counts: { waiting: 0, completed: 0 },
        nextCursor: null,
      });
    if (path === `${integration}/status`)
      return json({
        configured: false,
        accountConfigured: false,
        connected: false,
        creationEnabled: false,
      });
    if (path === operationUrl && method === 'GET')
      return json({
        orderId,
        number: '41-CRM',
        status: 'pendente',
        creationEnabled: false,
        pendingFields: [
          {
            code: 'OLIST_CREATION_DISABLED',
            label: 'Geração Olist ainda indisponível.',
          },
        ],
        operation: state.operation,
        payload: canary,
      });
    if (path === `${operationUrl}/administration` && method === 'GET')
      return json(state.diagnostic());
    if (path === `${operationUrl}/preview` && method === 'POST')
      return json({
        orderId,
        number: '41-CRM',
        status: 'pendente',
        eligible: true,
        creationEnabled: false,
        issues: [],
        commercial: {
          groups: [],
          totalCents: 300,
          orderDate: '2026-11-08',
          deliveryOn: '2026-11-30',
          paymentCondition: 'pix',
        },
        customer: { name: 'Comprador sintético', documentSuffix: '0091' },
        registrations: { customer: { action: 'reuse' }, groups: [] },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        previewToken: 'synthetic-new-preview-token',
      });
    if (path === `${operationUrl}/preview/check` && method === 'POST') {
      expect(body).toEqual({ previewToken: 'synthetic-new-preview-token' });
      expect(req.headers()['x-csrf-token']).toBe('l1-csrf');
      return json({
        valid: true,
        creationEnabled: false,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (path === `${operationUrl}/invalidate` && method === 'POST') {
      if (options.gate) await gate;
      const failure = state.failures.shift();
      if (failure) {
        // A resposta se perde depois da gravação: o resultado é incerto.
        if (failure.commits) state.commit();
        return json({ code: failure.code, detail: canary }, failure.status);
      }
      if (state.operation?.state === 'invalidated')
        return json({
          operationId: exportId,
          orderId,
          state: 'invalidated',
          version: state.version,
          replayed: true,
        });
      if (body.expectedVersion !== state.version)
        return json({ code: 'VERSION_CONFLICT', detail: canary }, 409);
      state.commit();
      return json({
        operationId: exportId,
        orderId,
        state: 'invalidated',
        version: state.version,
      });
    }
    // Qualquer outra rota (inclusive /export) falha a asserção de zero efeitos.
    return json({ code: 'FORBIDDEN' }, 403);
  });
  return state;
}

/** @param {{calls:Array<{path:string,method:string}>}} state @param {string} suffix */
const countCalls = (state, suffix, method = 'POST') =>
  state.calls.filter(
    ({ path, method: m }) => path.endsWith(suffix) && m === method,
  ).length;

/** @param {{calls:Array<{path:string,method:string,body?:any,key?:string}>}} state */
const invalidations = (state) =>
  state.calls.filter(
    ({ path, method }) => path.endsWith('/invalidate') && method === 'POST',
  );

/** Nenhuma criação: nem exportação, nem rota Olist desconhecida.
 * @param {{calls:Array<{path:string,method:string}>}} state */
function expectNoCreation(state) {
  expect(state.calls.filter(({ path }) => path.endsWith('/export'))).toEqual(
    [],
  );
}

/** @param {import('@playwright/test').Page} page */
const open = (page) => page.goto(`/olist?pedido=${orderId}`);
const openOrder = (/** @type {import('@playwright/test').Page} */ page) =>
  page.goto(`/pedidos/${orderId}`);

/** @param {import('@playwright/test').Page} page */
const trigger = (page) =>
  page.getByRole('button', { name: 'Invalidar esta geração', exact: true });
/** @param {import('@playwright/test').Page} page */
const dialogOf = (page) =>
  page.getByRole('dialog', { name: 'Invalidar esta geração?' });
/** @param {import('@playwright/test').Locator} dialog */
const reasonOf = (dialog) =>
  dialog.getByLabel('Motivo da invalidação (obrigatório)');
/** @param {import('@playwright/test').Page|import('@playwright/test').Locator} scope */
const submitOf = (scope) =>
  scope.getByRole('button', { name: 'Invalidar geração', exact: true });

const preparation = (/** @type {import('@playwright/test').Page} */ page) =>
  page.locator('.olist-preparation');

/** Two animation frames: what the page owes to a response is rendered. */
const frames = (/** @type {import('@playwright/test').Page} */ page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(() => resolve(null)),
        ),
      ),
  );

/** The shell refreshed the session after a live event: waits for it and for
 * the screen to settle, so "nothing disappeared" is proved after the fact. */
async function afterSessionRefresh(
  /** @type {import('@playwright/test').Page} */ page,
  /** @type {() => void} */ push,
) {
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/v1/sessions/current',
  );
  push();
  await refreshed;
  await frames(page);
}

const noRetry =
  /Tentar novamente|Repetir|Gerar de novo|Reabrir|Editar|Cancelar pedido/u;

test('L1 an admin invalidates a generation by keyboard, with focus, one command and a short message', async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await expect(trigger(page)).toBeVisible();
  await trigger(page).focus();
  await page.keyboard.press('Enter');
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  const reason = reasonOf(dialog);
  await expect(reason).toBeFocused();
  await expect(dialog).toContainText(
    'Os cadastros já criados no Olist são preservados e nada é apagado nem cancelado no Olist.',
  );
  await expect(dialog).toContainText('Não inclua dados pessoais do cliente.');
  await expect(dialog).toContainText(
    'Depois será preciso gerar uma nova prévia.',
  );

  // Escape fecha sem enviar e devolve o foco ao acionador.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(invalidations(state)).toHaveLength(0);

  // Voltar também fecha sem enviar.
  await trigger(page).click();
  await dialog.getByRole('button', { name: 'Voltar' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
  expect(invalidations(state)).toHaveLength(0);

  // Motivo obrigatório: erro anunciado, foco no campo, nada enviado.
  await trigger(page).click();
  await submitOf(dialog).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Informe o motivo da invalidação.',
  );
  await expect(reason).toBeFocused();
  expect(invalidations(state)).toHaveLength(0);

  await reason.fill(REASON);
  await submitOf(dialog).click();
  await expect(dialog).toHaveCount(0);

  const sent = invalidations(state);
  expect(sent).toHaveLength(1);
  expect(sent[0].body).toEqual({
    operationId: exportId,
    expectedVersion: VERSION,
    reason: REASON,
  });
  expect(sent[0].key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
  expect(
    state.calls.find(({ path }) => path.endsWith('/invalidate'))?.csrf,
  ).toBe('l1-csrf');

  // Mensagem curta, uma vez, na região viva; foco no botão da nova prévia.
  const recovery = page.locator('.olist-recovery');
  const live = recovery.locator('[role="status"][aria-live="polite"]');
  await expect(live).toContainText(SUCCESS_TEXT);
  await expect(page.getByText(SUCCESS_TEXT)).toHaveCount(1);
  await expect(
    page.getByRole('button', { name: 'Revisar envio' }),
  ).toBeFocused();
  await expect(trigger(page)).toHaveCount(0);
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Operação Olist invalidada',
  );
  await expect(page.locator('.olist-progress-guidance')).toHaveText(
    'Esta geração foi invalidada antes de qualquer venda. Gere uma nova prévia; cadastros já criados no Olist foram preservados.',
  );
  await expect(page.getByText(canary)).toHaveCount(0);
  expectNoCreation(state);
  await expect(
    preparation(page).getByRole('button', { name: noRetry }),
  ).toHaveCount(0);
  expect(state.consoleTexts.filter((text) => /pageerror/iu.test(text))).toEqual(
    [],
  );
});

test('L1 after the invalidation the panel offers a new preview and keeps offering it after a reload', async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await trigger(page).click();
  await reasonOf(dialogOf(page)).fill(REASON);
  await submitOf(dialogOf(page)).click();
  const confer = page.getByRole('button', { name: 'Revisar envio' });
  await expect(confer).toBeVisible();
  // O progresso arquivado segue visível, mas já não é uma operação ativa.
  await expect(
    page.getByRole('button', { name: 'Atualizar preparação' }),
  ).toHaveCount(0);
  await expect(preparation(page)).not.toContainText(
    'Não repita a geração. A conferência e a recuperação',
  );
  // O vínculo manual volta a valer: não há operação ativa.
  await expect(
    page.getByRole('button', { name: 'Vincular venda existente' }),
  ).toBeVisible();

  await page.reload();
  await expect(confer).toBeVisible();
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Operação Olist invalidada',
  );
  await expect(trigger(page)).toHaveCount(0);

  await confer.click();
  await expect(
    page.getByRole('heading', { name: 'Prévia pronta para conferência' }),
  ).toBeVisible();
  expect(countCalls(state, '/preview')).toBe(1);
  expect(countCalls(state, '/preview/check')).toBe(1);
  expect(invalidations(state)).toHaveLength(1);
  // Nada de exportação: gerar continua sendo um gesto humano posterior.
  expectNoCreation(state);
});

for (const failure of [
  [
    'OLIST_INVALIDATION_BLOCKED',
    /não pode ser invalidada: ela já passou da preparação ou teve uma tentativa de venda\. Nada foi alterado\./u,
  ],
  [
    'OLIST_EXPORT_IN_FLIGHT',
    /A geração está em execução agora\. Aguarde alguns instantes.*Nada foi alterado\./u,
  ],
  [
    'OLIST_RESOURCE_RECONCILIATION_REQUIRED',
    /Há um cadastro ainda sem resultado confirmado\. Use Conferir no Olist nesse cadastro; quando ele ficar confirmado, a geração poderá ser invalidada\./u,
  ],
  ['OLIST_EXPORT_UNAVAILABLE', /não está mais disponível/u],
  ['ORDER_CANCELLED', /Este pedido foi cancelado\. A ação está bloqueada\./u],
]) {
  test(`L1 a 409 ${failure[0]} keeps the dialog, the text and the focus on the alert`, async ({
    page,
  }) => {
    const state = await setup(page, {
      failures: [{ status: 409, code: String(failure[0]) }],
    });
    await open(page);
    await trigger(page).click();
    const dialog = dialogOf(page);
    await reasonOf(dialog).fill(REASON);
    await submitOf(dialog).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      /** @type {RegExp} */ (failure[1]),
    );
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(dialog).toBeVisible();
    await expect(reasonOf(dialog)).toHaveValue(REASON);
    await expect(reasonOf(dialog)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText(canary)).toHaveCount(0);
    expect(invalidations(state)).toHaveLength(1);
    await expect(
      page.locator('.olist-recovery-result').filter({ hasText: /Geração/u }),
    ).toHaveCount(0);
    // Voltar fecha sem enviar e devolve o foco.
    await dialog.getByRole('button', { name: 'Voltar' }).click();
    await expect(dialog).toHaveCount(0);
    expect(invalidations(state)).toHaveLength(1);
    expectNoCreation(state);
  });
}

test('L1 a replay is told as such and the operation stays archived', async ({
  page,
}) => {
  // Outra aba já invalidou: o servidor devolve 200 com replayed.
  const state = await setup(page);
  await open(page);
  await trigger(page).click();
  state.commit();
  await reasonOf(dialogOf(page)).fill(REASON);
  await submitOf(dialogOf(page)).click();
  await expect(dialogOf(page)).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toHaveText(
    'Esta geração já estava invalidada. Nada mudou; gere uma nova prévia.',
  );
  await expect(
    page.getByRole('button', { name: 'Revisar envio' }),
  ).toBeFocused();
  expect(invalidations(state)).toHaveLength(1);
  expectNoCreation(state);
});

for (const viewer of /** @type {const} */ (['seller', 'finance'])) {
  test(`L1 a ${viewer} only enabled for Olist neither sees the button nor calls the route`, async ({
    page,
  }) => {
    const state = await setup(page, { viewer });
    await open(page);
    await expect(preparation(page)).toBeVisible();
    await expect(page.locator('.olist-progress')).toBeVisible();
    await expect(trigger(page)).toHaveCount(0);
    await expect(page.locator('.olist-recovery')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Invalidar|Conferir no Olist/u }),
    ).toHaveCount(0);
    expect(invalidations(state)).toHaveLength(0);
    expect(countCalls(state, '/administration', 'GET')).toBe(0);
  });
}

for (const [label, patch] of /** @type {Array<[string, Options]>} */ ([
  [
    'a sale attempt',
    {
      attempts: [
        ...readyAttempts(),
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
          resourceId: null,
          stage: 'sale',
          outcome: 'rejected',
          observedRemoteId: null,
          code: 'OLIST_UPSTREAM_REJECTED',
          createdAt: '2026-11-08T13:00:00.000Z',
          finishedAt: '2026-11-08T13:00:02.000Z',
        },
      ],
    },
  ],
  [
    'an uncertain registration',
    {
      resources: [
        ...readyResources(),
        resource(
          '33333331-3333-4333-8333-333333333331',
          'variation',
          'uncertain',
          4,
          null,
        ),
      ],
    },
  ],
  [
    'a reserved registration',
    {
      resources: [
        ...readyResources(),
        resource(
          '33333332-3333-4333-8333-333333333332',
          'variation',
          'reserved',
          1,
          null,
        ),
      ],
    },
  ],
  ['a reserved sale', { operation: op('reserved', 'sale') }],
  [
    'an uncertain operation',
    {
      operation: op('uncertain', 'variation', {
        errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
      }),
    },
  ],
  [
    'a confirmed sale',
    { operation: op('confirmed', 'complete', { number: '9' }) },
  ],
  ['a rejected operation', { operation: op('rejected', 'customer') }],
])) {
  test(`L1 the button is not offered with ${label}`, async ({ page }) => {
    const state = await setup(page, patch);
    await open(page);
    await expect(page.locator('.olist-recovery')).toBeVisible();
    await expect(
      page.locator('.olist-recovery').getByRole('heading', {
        name: 'Conferência administrativa',
      }),
    ).toBeVisible();
    // The diagnosis (with its attempt history) is on screen: the absence of the
    // button is a decision, not a read still in flight.
    await expect(page.locator('details.olist-attempts')).toBeVisible();
    await expect(trigger(page)).toHaveCount(0);
    expect(invalidations(state)).toHaveLength(0);
  });
}

test('L1 a cancelled order does not offer the invalidation but keeps the history', async ({
  page,
}) => {
  const state = await setup(page, {
    order: {
      ...pendingOrder,
      id: orderId,
      number: '41-CRM',
      cancelledAt: '2026-11-08T14:00:00.000Z',
      cancelledBy: { id: 'seller-marina', name: 'Marina Aguiar' },
      cancellationReason: 'Pedido duplicado',
      effectiveStatus: 'cancelado',
      version: 5,
    },
  });
  await openOrder(page);
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  const panel = preparation(page);
  await expect(panel.locator('.olist-recovery')).toContainText(
    'A conferência e o vínculo estão bloqueados',
  );
  await expect(panel.locator('.olist-progress')).toBeVisible();
  await expect(trigger(page)).toHaveCount(0);
  await expect(
    panel.getByRole('button', {
      name: /Invalidar|Conferir prévia|Vincular venda|Gerar venda/u,
    }),
  ).toHaveCount(0);
  expect(invalidations(state)).toHaveLength(0);
});

test('L1 a multiline reason is flattened before the command is sent', async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  await reasonOf(dialog).fill('Cliente pediu\nrefazer\tpedido');
  await submitOf(dialog).click();
  await expect(dialog).toHaveCount(0);
  const sent = invalidations(state);
  expect(sent).toHaveLength(1);
  expect(sent[0].body.reason).toBe('Cliente pediu refazer pedido');
  expect(sent[0].body.reason).not.toMatch(/[\u0000-\u001f\u007f]/u);
});

test('L1 a reason made only of line breaks or over 1000 characters is refused before any call', async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  await reasonOf(dialog).fill('\n\t\n');
  await submitOf(dialog).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Informe o motivo da invalidação.',
  );
  await expect(reasonOf(dialog)).toBeFocused();
  // O campo limita a 1000; um valor acima disso só entra por script.
  await reasonOf(dialog).evaluate((node) => {
    const field = /** @type {HTMLTextAreaElement} */ (node);
    field.removeAttribute('maxlength');
    field.value = 'a'.repeat(1001);
    field.dispatchEvent(new globalThis.Event('input', { bubbles: true }));
  });
  await submitOf(dialog).click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'O motivo pode ter no máximo 1000 caracteres.',
  );
  expect(invalidations(state)).toHaveLength(0);
});

test('L1 a 5xx keeps the dialog and the same key on the resend, and a new reason takes a new key', async ({
  page,
}) => {
  const state = await setup(page, {
    failures: [
      { status: 503, code: 'UNAVAILABLE' },
      { status: 502, code: 'BAD_GATEWAY' },
    ],
  });
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  await reasonOf(dialog).fill(REASON);
  await submitOf(dialog).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'ela pode não ter sido registrada',
  );
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(reasonOf(dialog)).toHaveValue(REASON);
  // Relê o diagnóstico e a projeção: nada é reenviado por conta própria.
  await expect
    .poll(() => countCalls(state, '/administration', 'GET'))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => countCalls(state, operationUrl, 'GET'))
    .toBeGreaterThanOrEqual(2);
  expect(invalidations(state)).toHaveLength(1);

  // O reenvio é o mesmo comando: mesma chave, mesmo corpo.
  await submitOf(dialog).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'ela pode não ter sido registrada',
  );
  expect(invalidations(state)).toHaveLength(2);
  expect(invalidations(state)[1].key).toBe(invalidations(state)[0].key);
  expect(invalidations(state)[1].body).toEqual(invalidations(state)[0].body);

  // Outro motivo é outro comando: outra chave.
  await reasonOf(dialog).fill(`${REASON} (revisado)`);
  await submitOf(dialog).click();
  await expect(dialog).toHaveCount(0);
  expect(invalidations(state)).toHaveLength(3);
  expect(invalidations(state)[2].key).not.toBe(invalidations(state)[0].key);
  expect(invalidations(state)[2].body.reason).toBe(`${REASON} (revisado)`);
  await expect(page.locator('.olist-recovery-result')).toHaveText(SUCCESS_TEXT);
  expectNoCreation(state);
});

test('L1 a lost answer after the server recorded it closes the dialog saying so', async ({
  page,
}) => {
  const state = await setup(page, {
    failures: [{ status: 503, code: 'UNAVAILABLE', commits: true }],
  });
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  await reasonOf(dialog).fill(REASON);
  await submitOf(dialog).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toHaveText(
    'A invalidação foi registrada, apesar da falha na resposta. Gere uma nova prévia.',
  );
  await expect(
    page.getByRole('button', { name: 'Revisar envio' }),
  ).toBeFocused();
  await expect(trigger(page)).toHaveCount(0);
  expect(invalidations(state)).toHaveLength(1);
  await expect(page.getByText(canary)).toHaveCount(0);
});

test('L1 a version conflict keeps the text, re-reads the diagnosis and the next send uses the new version with a new key', async ({
  page,
}) => {
  const state = await setup(page);
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  // Outra pessoa mexeu na geração depois do diagnóstico que esta tela mostra.
  state.version = VERSION + 1;
  await reasonOf(dialog).fill(REASON);
  await submitOf(dialog).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'O estado da etapa mudou desde o diagnóstico.',
  );
  await expect(reasonOf(dialog)).toHaveValue(REASON);
  await expect
    .poll(() => countCalls(state, '/administration', 'GET'))
    .toBeGreaterThanOrEqual(2);
  // O diálogo já assumiu a versão nova quando a releitura foi renderizada.
  await frames(page);
  await submitOf(dialog).click();
  await expect(dialog).toHaveCount(0);
  const sent = invalidations(state);
  expect(sent).toHaveLength(2);
  expect(sent[0].body.expectedVersion).toBe(VERSION);
  expect(sent[1].body.expectedVersion).toBe(VERSION + 1);
  expect(sent[1].key).not.toBe(sent[0].key);
});

test('L1 a double activation sends exactly one command', async ({ page }) => {
  const state = await setup(page, { gate: true });
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  await reasonOf(dialog).fill(REASON);
  await submitOf(dialog).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => invalidations(state).length).toBe(1);
  await expect(
    dialog.getByRole('button', { name: 'Invalidando…' }),
  ).toBeDisabled();
  await dialog.locator('button.primary').dispatchEvent('click');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  state.release();
  await expect(dialog).toHaveCount(0);
  expect(invalidations(state)).toHaveLength(1);
});

test('L1 a 403 on the command removes the administrative controls', async ({
  page,
}) => {
  const state = await setup(page, {
    failures: [{ status: 403, code: 'FORBIDDEN' }],
  });
  await open(page);
  await trigger(page).click();
  await reasonOf(dialogOf(page)).fill(REASON);
  await submitOf(dialogOf(page)).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.locator('.olist-recovery').getByRole('alert'),
  ).toContainText('Seu acesso mudou ou sua sessão expirou');
  await expect(
    page.getByRole('button', {
      name: /Invalidar|Conferir no Olist|Vincular venda/u,
    }),
  ).toHaveCount(0);
  expect(invalidations(state)).toHaveLength(1);
  await expect(page.getByText(canary)).toHaveCount(0);
});

test('L1 a live reset with the dialog open keeps the dialog, the text and the focus, and applies the command in flight', async ({
  page,
}) => {
  const state = await setup(page, {
    operation: op('queued', 'customer'),
    resources: [],
    attempts: [],
    liveEvents: true,
    gate: true,
  });
  await open(page);
  await trigger(page).click();
  const dialog = dialogOf(page);
  const reason = reasonOf(dialog);
  await reason.fill(REASON);
  await reason.focus();
  // A DOM mark: a remounted dialog would not carry it.
  await dialog.evaluate((node) => node.setAttribute('data-keep', '1'));

  await afterSessionRefresh(page, () => state.pushEvent('stream.reset', {}));
  await expect(page.locator('dialog[data-keep="1"]')).toBeVisible();
  await expect(reason).toHaveValue(REASON);
  await expect(reason).toBeFocused();

  // Um comando em voo atravessa um segundo reset: a resposta é aplicada.
  await submitOf(dialog).click();
  await expect.poll(() => invalidations(state).length).toBe(1);
  await afterSessionRefresh(page, () => state.pushEvent('stream.reset', {}));
  await expect(page.locator('dialog[data-keep="1"]')).toBeVisible();
  state.release();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toHaveText(SUCCESS_TEXT);
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Operação Olist invalidada',
  );
  await expect(
    page.getByRole('button', { name: 'Revisar envio' }),
  ).toBeVisible();
  expect(invalidations(state)).toHaveLength(1);
  expectNoCreation(state);
});

for (const viewport of [
  { width: 320, height: 760, name: 'mobile320' },
  { width: 390, height: 844, name: 'mobile390' },
  { width: 1366, height: 900, name: 'desktop1366' },
]) {
  test(`L1 invalidation has axe, reflow and keyboard evidence ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const state = await setup(page, {
      failures: [{ status: 409, code: 'OLIST_INVALIDATION_BLOCKED' }],
    });
    const noOverflow = () =>
      page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      );
    await open(page);
    await expect(trigger(page)).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await noOverflow()).toBe(true);

    await trigger(page).click();
    const dialog = dialogOf(page);
    await expect(dialog).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const box = await dialog.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({
      path: `var/olist-l1-invalidate-dialog-${viewport.name}.png`,
    });

    // Estado de erro: o alerta recebe o foco e continua acessível.
    await reasonOf(dialog).fill(REASON);
    await submitOf(dialog).click();
    await expect(dialog.getByRole('alert')).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await noOverflow()).toBe(true);
    await page.screenshot({
      path: `var/olist-l1-invalidate-error-${viewport.name}.png`,
    });

    // Tudo pelo teclado: reenvio no mesmo diálogo, sucesso e foco no próximo passo.
    await reasonOf(dialog).focus();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Voltar' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(submitOf(dialog)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Revisar envio' }),
    ).toBeFocused();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(await noOverflow()).toBe(true);
    await page.screenshot({
      path: `var/olist-l1-invalidated-${viewport.name}.png`,
      fullPage: true,
    });
    expect(invalidations(state)).toHaveLength(2);
    expectNoCreation(state);
  });
}
