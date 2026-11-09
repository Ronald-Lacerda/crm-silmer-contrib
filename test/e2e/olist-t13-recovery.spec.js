import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockOrders, pendingOrder } from './support/orders-mock.js';

// OLIST-T13 (RFC 050): progresso por etapa, histórico, conferência e vínculo
// no painel Olist do Pedido. Tudo sintético: toda rota Olist é interceptada e
// nenhum POST de criação existe. /export e qualquer rota desconhecida falham o
// teste em vez de alcançar uma API real.

const orderId = 'acbf1c1b-c57f-4c5c-8076-7f439f95cfb0';
const exportId = '5b0a1d1e-5a8e-4f55-9a53-2f1b3c0f6e11';
const customerId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variationIds = [1, 2, 3, 4, 5].map(
  (index) => `3333333${index}-3333-4333-8333-33333333333${index}`,
);
const requestId = '99999999-9999-4999-8999-999999999999';
const integration = '/api/v1/integrations/olist';
const operationUrl = `/api/v1/orders/${orderId}/olist`;
const canary = 'provider-payload-secret-canary';
const tokenCanary = 'synthetic-existing-review-token';
const REASON = 'Venda lançada manualmente pela operadora';

/** @param {string} state @param {string} stage @param {Record<string, any>} [extra] */
function op(state, stage, extra = {}) {
  return { state, stage, number: null, ...extra };
}

/** @param {Record<string, any>} operation @param {Record<string, any>} [overrides] */
function administration(operation, overrides = {}) {
  return {
    operation: operation
      ? { id: exportId, actorId: 'admin-synthetic', version: 7, ...operation }
      : null,
    resources: [],
    requests: [],
    attempts: [],
    attemptHistoryTruncated: false,
    ...overrides,
  };
}

const uncertainVariationAdmin = () =>
  administration(op('uncertain', 'variation'), {
    resources: [
      resource(customerId, 'customer', 'confirmed', 2, '100'),
      resource(productId, 'product', 'confirmed', 3, '200'),
      resource(variationIds[0], 'variation', 'confirmed', 2, '301', productId),
      resource(variationIds[1], 'variation', 'confirmed', 2, '302', productId),
      resource(variationIds[2], 'variation', 'confirmed', 2, '303', productId),
      resource(variationIds[3], 'variation', 'uncertain', 4, null, productId),
      resource(variationIds[4], 'variation', 'pending', 0, null, productId),
    ],
    attempts: [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        resourceId: variationIds[3],
        stage: 'variation',
        outcome: 'uncertain',
        observedRemoteId: null,
        code: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
        createdAt: '2026-11-08T13:00:00.000Z',
        finishedAt: '2026-11-08T13:00:04.000Z',
        // Campos que a API nunca envia: não podem aparecer em lugar nenhum.
        payload: canary,
        token: canary,
      },
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        resourceId: variationIds[2],
        stage: 'variation',
        outcome: 'confirmed',
        observedRemoteId: '303',
        code: null,
        createdAt: '2026-11-08T12:59:00.000Z',
        finishedAt: '2026-11-08T12:59:02.000Z',
      },
    ],
  });

/** @param {string} id @param {string} kind @param {string} state @param {number} version @param {string|null} remoteId @param {string|null} [parentId] */
function resource(id, kind, state, version, remoteId, parentId = null) {
  return { id, kind, state, version, remoteId, parentId };
}

/**
 * @typedef {{
 *   viewer?: 'seller'|'finance'|'admin',
 *   enabled?: boolean,
 *   operation?: any,
 *   admin?: any,
 *   adminStatus?: number,
 *   reconcileFailure?: {status:number, code:string},
 *   previewFailure?: {status:number, code:string},
 *   linkFailure?: {status:number, code:string},
 *   linkCommitsThenFails?: {status:number, code:string},
 *   gateReconcile?: boolean,
 *   gateLink?: boolean,
 *   liveEvents?: boolean,
 *   order?: Record<string, any>,
 *   lookup?: Record<string, any>,
 * }} Options
 */

/** @param {import('@playwright/test').Page} page @param {Options} [options] */
async function setup(page, options = {}) {
  const profile = options.viewer ?? 'seller';
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
      options.operation === undefined ? null : options.operation,
    /** @type {any} */ admin:
      options.admin ?? administration(options.operation ?? null),
    requestStatus: 'queued',
    /** @type {string|undefined} */ requestCode: undefined,
    /** @type {Array<{path:string,method:string,body:any,key?:string,csrf?:string}>} */
    calls: [],
    /** @type {string[]} */ consoleTexts: [],
    releaseReconcile: () => {},
    releaseLink: () => {},
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
  };
  const reconcileGate = new Promise((resolve) => {
    state.releaseReconcile = () => resolve(null);
  });
  const linkGate = new Promise((resolve) => {
    state.releaseLink = () => resolve(null);
  });
  page.on('console', (message) => state.consoleTexts.push(message.text()));
  page.on('pageerror', (error) => state.consoleTexts.push(String(error)));
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 't13-csrf', url: 'http://127.0.0.1:4173' },
    ]);
  // Order page: the generic order mock answers what this handler does not
  // (files, shipping quote), and this handler is registered after it so it
  // takes precedence on the Olist routes.
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
      // Long poll: each connection delivers the next pushed event and the
      // browser reconnects after 200 ms for the following one.
      /** @type {{name: string, data: any}} */
      const next =
        state.queue.shift() ??
        (await new Promise((resolve) => state.waiters.push(resolve)));
      state.eventSeq += 1;
      return route.fulfill({
        contentType: 'text/event-stream',
        body: `retry: 200\n\nevent: ${next.name}\nid: t13-${state.eventSeq}\ndata: ${JSON.stringify(next.data)}\n\n`,
      });
    }
    if (path === '/api/v1/orders/summary') return json({ storeNewCount: 0 });
    if (options.order && path === `/api/v1/orders/${orderId}`) {
      if (method === 'GET') return json({ order: state.order });
    }
    if (
      options.order &&
      path === `/api/v1/orders/${orderId}/cancel` &&
      method === 'POST'
    ) {
      state.order = {
        ...state.order,
        cancelledAt: '2026-11-08T15:30:00.000Z',
        cancelledBy: { id: viewer.id, name: viewer.name },
        cancellationReason: body.reason,
        effectiveStatus: 'cancelado',
        version: state.order.version + 1,
      };
      return json({ order: state.order });
    }
    if (path === `${integration}/order-lookup` && options.lookup) {
      return json(options.lookup);
    }
    if (path === '/api/v1/integrations/olist/status')
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
        // A API nunca devolve isso; se algum dia vazar, a tela não pode mostrar.
        payload: canary,
      });
    if (path === `${operationUrl}/administration` && method === 'GET') {
      if (options.adminStatus)
        return json({ code: 'FORBIDDEN' }, options.adminStatus);
      return json(state.admin);
    }
    if (path === `${operationUrl}/reconcile` && method === 'POST') {
      if (options.gateReconcile) await reconcileGate;
      if (options.reconcileFailure)
        return json(
          { code: options.reconcileFailure.code, detail: canary },
          options.reconcileFailure.status,
        );
      return json(
        {
          id: requestId,
          requestId,
          exportId,
          resourceId: body.resourceId,
          stage: body.stage,
          status: 'queued',
          version: 1,
        },
        202,
      );
    }
    if (path === `${operationUrl}/reconciliations/${requestId}`) {
      const first = state.calls.find(({ path: p }) => p.endsWith('/reconcile'));
      return json({
        id: requestId,
        requestId,
        exportId,
        resourceId: first?.body?.resourceId ?? null,
        stage: first?.body?.stage ?? 'variation',
        status: state.requestStatus,
        version: state.requestStatus === 'queued' ? 1 : 2,
        ...(state.requestCode ? { code: state.requestCode } : {}),
      });
    }
    if (path === `${operationUrl}/existing/previews` && method === 'POST') {
      if (options.previewFailure)
        return json(
          { code: options.previewFailure.code, detail: canary },
          options.previewFailure.status,
        );
      return json({
        orderId,
        eligible: true,
        creationEnabled: false,
        sale: { id: body.saleId, number: '9000' },
        versions: {
          order: 4,
          operation: 0,
          settings: 3,
          connection: 5,
          authorization: 2,
        },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        previewToken: tokenCanary,
      });
    }
    if (path === `${operationUrl}/links` && method === 'POST') {
      if (options.gateLink) await linkGate;
      // Outra aba já vinculou a mesma venda: commitLink devolve 200 convergente
      // com o recibo da operação já vinculada (admin-repository.js, linked).
      if (state.operation?.state === 'linked')
        return json({
          operationId: exportId,
          orderId,
          state: 'linked',
          stage: 'complete',
          number: state.operation.number,
          creationEnabled: false,
        });
      if (options.linkFailure)
        return json(
          { code: options.linkFailure.code, detail: canary },
          options.linkFailure.status,
        );
      state.operation = op('linked', 'complete', { number: '9000' });
      state.admin = administration(state.operation);
      // A resposta se perde depois da gravação: o resultado é incerto.
      if (options.linkCommitsThenFails)
        return json(
          { code: options.linkCommitsThenFails.code, detail: canary },
          options.linkCommitsThenFails.status,
        );
      return json({
        operationId: exportId,
        orderId,
        state: 'linked',
        stage: 'complete',
        number: '9000',
        creationEnabled: false,
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

/** @param {{calls:Array<{path:string,method:string}>}} state */
function expectNoCreation(state) {
  expect(
    state.calls.filter(
      ({ path }) =>
        path.endsWith('/export') ||
        path.endsWith('/preview') ||
        path.endsWith('/preview/check'),
    ),
  ).toEqual([]);
}

/** @param {import('@playwright/test').Page} page @param {string} step */
const stepLocator = (page, step) =>
  page.locator(`.olist-step[data-step="${step}"]`);

/** @param {import('@playwright/test').Page} page */
const open = (page) => page.goto(`/olist?pedido=${orderId}`);

const preparation = (/** @type {import('@playwright/test').Page} */ page) =>
  page.locator('.olist-preparation');

const noRetry =
  /Tentar novamente|Repetir|Gerar de novo|Reabrir|Editar|Cancelar pedido/u;

/** @type {Array<[string, string, string[], RegExp]>} */
const STATES = [
  [
    'queued',
    'customer',
    ['waiting', 'waiting', 'waiting'],
    /em acompanhamento/u,
  ],
  [
    'resolving',
    'customer',
    ['active', 'waiting', 'waiting'],
    /em acompanhamento/u,
  ],
  [
    'resolving',
    'variation',
    ['done', 'active', 'waiting'],
    /em acompanhamento/u,
  ],
  ['ready', 'sale', ['done', 'done', 'waiting'], /em acompanhamento/u],
  ['reserved', 'sale', ['done', 'done', 'active'], /em acompanhamento/u],
  ['confirmed', 'complete', ['done', 'done', 'done'], /Venda Olist conferida/u],
  ['linked', 'complete', ['done', 'done', 'done'], /Venda Olist conferida/u],
  [
    'uncertain',
    'product',
    ['done', 'blocked', 'waiting'],
    /bloqueada para conferência/u,
  ],
  [
    'rejected',
    'customer',
    ['rejected', 'waiting', 'waiting'],
    /Operação Olist rejeitada/u,
  ],
  [
    'invalidated',
    'sale',
    ['done', 'done', 'invalidated'],
    /Operação Olist invalidada/u,
  ],
];

for (const [stateName, stage, expected, headline] of STATES) {
  test(`T13 progress renders ${stateName}/${stage} for an enabled user, survives reload and exposes no admin control`, async ({
    page,
  }) => {
    const state = await setup(page, {
      operation: op(stateName, stage, {
        number: ['confirmed', 'linked'].includes(stateName) ? '500' : null,
        ...(stateName === 'rejected'
          ? { errorCode: 'OLIST_UPSTREAM_REJECTED' }
          : {}),
      }),
    });
    await open(page);
    const progress = page.locator('.olist-progress');
    await expect(progress).toBeVisible();
    await expect(progress.locator('.olist-progress-headline')).toHaveText(
      headline,
    );
    for (const [index, key] of ['customer', 'product', 'sale'].entries())
      await expect(stepLocator(page, key)).toHaveAttribute(
        'data-status',
        expected[index],
      );
    // O estado nunca depende só de cor: cada etapa tem rótulo textual.
    await expect(progress.locator('.olist-step-status')).toHaveCount(3);
    await page.reload();
    for (const [index, key] of ['customer', 'product', 'sale'].entries())
      await expect(stepLocator(page, key)).toHaveAttribute(
        'data-status',
        expected[index],
      );
    await expect(
      preparation(page).getByRole('button', { name: noRetry }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Enviar para Olist|Revisar envio/u }),
    ).toHaveCount(0);
    // Quem só está habilitado lê o estado: nada administrativo é pedido ou mostrado.
    await expect(page.locator('.olist-recovery')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /Conferir no Olist|Vincular venda/u }),
    ).toHaveCount(0);
    expect(
      state.calls.filter(({ path }) =>
        /administration|reconcil|links|existing/u.test(path),
      ),
    ).toEqual([]);
    expectNoCreation(state);
    await expect(page.getByText(canary)).toHaveCount(0);
  });
}

test('T13 uncertainty blocks the stage, explains it safely and never offers a repeat', async ({
  page,
}) => {
  const state = await setup(page, {
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
  });
  await open(page);
  await expect(stepLocator(page, 'product')).toHaveAttribute(
    'data-status',
    'blocked',
  );
  await expect(stepLocator(page, 'product')).toContainText(
    'Bloqueada por incerteza',
  );
  await expect(stepLocator(page, 'product')).toContainText(
    'pode existir no Olist',
  );
  await expect(stepLocator(page, 'sale')).toContainText(
    'Aguarda a conferência da etapa Produto e variações',
  );
  await expect(page.locator('.olist-progress')).toContainText(
    'Não repita a geração',
  );
  await expect(
    preparation(page).getByRole('button', { name: noRetry }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Enviar para Olist|Revisar envio/u }),
  ).toHaveCount(0);
  expectNoCreation(state);
});

test('T13 terminal states are not re-read by the bounded CRM follow-up', async ({
  page,
}) => {
  const state = await setup(page, { operation: op('uncertain', 'sale') });
  await open(page);
  await expect(stepLocator(page, 'sale')).toHaveAttribute(
    'data-status',
    'blocked',
  );
  await page.waitForTimeout(4600);
  expect(countCalls(state, operationUrl, 'GET')).toBe(1);
});

test('T13 an operation underway is re-read from the CRM only, announcing just the change', async ({
  page,
}) => {
  const state = await setup(page, { operation: op('queued', 'customer') });
  await open(page);
  await expect(stepLocator(page, 'customer')).toHaveAttribute(
    'data-status',
    'waiting',
  );
  const live = page.locator('.olist-progress [role="status"]');
  await expect(live).toHaveText('');
  state.operation = op('resolving', 'product');
  await expect(stepLocator(page, 'product')).toHaveAttribute(
    'data-status',
    'active',
    { timeout: 12_000 },
  );
  await expect(stepLocator(page, 'customer')).toHaveAttribute(
    'data-status',
    'done',
  );
  // Só a mudança relevante é anunciada, nunca a lista de etapas inteira.
  await expect(live).toHaveText('Etapa Produto e variações: em andamento.');
  expect(countCalls(state, operationUrl, 'GET')).toBeGreaterThanOrEqual(2);
  expect(
    state.calls.filter(({ path }) =>
      /integrations\/olist\/(lookups|mappings)/u.test(path),
    ),
  ).toEqual([]);
  expectNoCreation(state);
});

test('T13 a sent sale shows both numbers and offers no edit, cancel, reopen or generate', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: op('linked', 'complete', { number: '9000' }),
  });
  await open(page);
  const progress = page.locator('.olist-progress');
  await expect(progress.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await expect(progress.locator('dl')).toContainText('Pedido CRM');
  await expect(progress.locator('dl')).toContainText('41-CRM');
  await expect(progress.locator('dl')).toContainText('9000');
  await expect(progress.locator('dl')).toContainText(
    'Vinculada a uma venda que já existia no Olist',
  );
  await expect(
    page.locator('.olist-preparation').getByRole('button', {
      name: /Editar|Cancelar|Reabrir|Gerar|Tentar novamente|Vincular/u,
    }),
  ).toHaveCount(0);
});

test('T13 admin sees counts, resources, history with truncation, and no payload or token', async ({
  page,
}) => {
  /** @type {any} */
  const admin = uncertainVariationAdmin();
  admin.attemptHistoryTruncated = true;
  admin.attempts[0].observedRemoteId = '<img src=x onerror=alert(1)>';
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin,
  });
  await open(page);
  await expect(stepLocator(page, 'customer')).toContainText(
    '1 de 1 cliente vinculado',
  );
  await expect(stepLocator(page, 'product')).toContainText(
    '3 de 5 variações vinculadas',
  );
  await expect(stepLocator(page, 'product')).toContainText(
    '1 de 1 produto vinculado',
  );
  const recovery = page.locator('.olist-recovery');
  await expect(
    recovery.getByRole('heading', { name: 'Conferência administrativa' }),
  ).toBeVisible();
  await expect(recovery.locator('.olist-recovery-list').first()).toContainText(
    'Variação 4 de 5',
  );
  // Só recursos reservados, incertos ou rejeitados oferecem conferência.
  await expect(
    recovery.getByRole('button', {
      name: /^Conferir no Olist: Variação 4 de 5/u,
    }),
  ).toBeVisible();
  await expect(
    recovery.getByRole('button', { name: /^Conferir no Olist/u }),
  ).toHaveCount(1);
  const history = recovery.locator('details.olist-attempts');
  await history.locator('summary').click();
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history).toContainText('Incerta');
  await expect(history).toContainText('OLIST_RESOURCE_OUTCOME_UNKNOWN');
  await expect(history).toContainText('Confirmada');
  await expect(history).toContainText('ID Olist observado 303');
  await expect(history).toContainText(
    'Mostrando as 100 tentativas mais recentes',
  );
  // Identificador remoto inseguro é omitido; nada é interpretado como HTML.
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
  await expect(page.getByText(canary)).toHaveCount(0);
  expect(await page.content()).not.toContain(canary);
  expect(state.consoleTexts.join('\n')).not.toContain(canary);
  expect(countCalls(state, '/administration', 'GET')).toBe(1);
  expectNoCreation(state);
});

test('T13 an admin with an operation in the queue loads the diagnosis exactly once', async ({
  page,
}) => {
  const admin = await setup(page, {
    viewer: 'admin',
    operation: op('queued', 'customer'),
  });
  await open(page);
  await expect(page.locator('.olist-recovery')).toBeVisible();
  await expect.poll(() => countCalls(admin, '/administration', 'GET')).toBe(1);
});

test('T13 reconcile asks for a reason, keeps focus, sends the target version and follows the persisted result', async ({
  page,
}) => {
  const admin = uncertainVariationAdmin();
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin,
  });
  await open(page);
  const trigger = page.getByRole('button', {
    name: /^Conferir no Olist: Variação 4 de 5/u,
  });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const reason = dialog.getByLabel('Motivo da conferência (obrigatório)');
  await expect(reason).toBeFocused();
  // Escape fecha sem enviar e devolve o foco ao acionador.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(countCalls(state, '/reconcile')).toBe(0);
  // Motivo obrigatório: erro anunciado e foco no campo.
  await trigger.click();
  await dialog
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Informe o motivo da conferência.',
  );
  await expect(reason).toBeFocused();
  expect(countCalls(state, '/reconcile')).toBe(0);
  await reason.fill(REASON);
  await dialog
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const sent = state.calls.find(({ path }) => path.endsWith('/reconcile'));
  expect(sent?.body).toEqual({
    stage: 'variation',
    resourceId: variationIds[3],
    expectedVersion: 4,
    reason: REASON,
  });
  expect(sent?.key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
  expect(sent?.csrf).toBe('t13-csrf');
  const recovery = page.locator('.olist-recovery');
  await expect(recovery).toContainText(
    'solicitada. O resultado aparece em Conferências solicitadas',
  );
  const queued = recovery.locator('section', {
    has: page.getByRole('heading', { name: 'Conferências solicitadas' }),
  });
  await expect(queued).toContainText('Na fila');
  // A conferência só lê: o resultado vem do ledger persistido do CRM.
  state.requestStatus = 'succeeded';
  state.operation = op('resolving', 'variation');
  state.admin = administration(op('resolving', 'variation'), {
    resources: admin.resources.map((/** @type {any} */ item) =>
      item.id === variationIds[3]
        ? { ...item, state: 'confirmed', version: 5, remoteId: '304' }
        : item,
    ),
  });
  await queued.getByRole('button', { name: /^Atualizar resultado/u }).click();
  await expect(recovery).toContainText(
    'Conferência de Variação 4 de 5 (final 333334) concluída. O progresso foi atualizado.',
  );
  await expect(stepLocator(page, 'product')).toHaveAttribute(
    'data-status',
    'active',
  );
  await expect(stepLocator(page, 'product')).toContainText(
    '4 de 5 variações vinculadas',
  );
  await expect(
    page.getByRole('button', { name: /^Conferir no Olist/u }),
  ).toHaveCount(0);
  // The refresh button left the screen with the state change: the focus lands
  // on the result region title, never on the body.
  await expect(
    queued.getByRole('heading', { name: 'Conferências solicitadas' }),
  ).toBeFocused();
  expect(countCalls(state, `/reconciliations/${requestId}`, 'GET')).toBe(1);
  expectNoCreation(state);
  await expect(
    preparation(page).getByRole('button', { name: noRetry }),
  ).toHaveCount(0);
});

test('T13 reconcile of the sale stage sends a null resource and the operation version', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'sale', { errorCode: 'OLIST_SALE_UNCERTAIN' }),
    admin: administration(
      op('uncertain', 'sale', { errorCode: 'OLIST_SALE_UNCERTAIN' }),
      {
        resources: [
          resource(customerId, 'customer', 'confirmed', 2, '100'),
          resource(productId, 'product', 'confirmed', 3, '200'),
        ],
      },
    ),
  });
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Venda/u })
    .click();
  await page.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  await page
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    state.calls.find(({ path }) => path.endsWith('/reconcile'))?.body,
  ).toEqual({
    stage: 'sale',
    resourceId: null,
    expectedVersion: 7,
    reason: REASON,
  });
});

test('T13 a blocked reconciliation keeps the stage blocked and says nothing was released', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
  });
  state.requestStatus = 'blocked';
  state.requestCode = 'OLIST_AMBIGUOUS_MATCH';
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
    .click();
  await page.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  await page
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await page.getByRole('button', { name: /^Atualizar resultado/u }).click();
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'concluída sem provar o resultado. Nenhuma criação foi liberada.',
  );
  await expect(stepLocator(page, 'product')).toHaveAttribute(
    'data-status',
    'blocked',
  );
  await expect(
    preparation(page).getByRole('button', { name: noRetry }),
  ).toHaveCount(0);
});

test('T13 a double activation of Solicitar conferência sends exactly one command', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
    gateReconcile: true,
  });
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  const submit = dialog.getByRole('button', {
    name: 'Solicitar conferência',
    exact: true,
  });
  await submit.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => countCalls(state, '/reconcile')).toBe(1);
  await dialog.locator('button.primary').dispatchEvent('click');
  await page.keyboard.press('Enter');
  state.releaseReconcile();
  await expect(dialog).toHaveCount(0);
  expect(countCalls(state, '/reconcile')).toBe(1);
});

for (const failure of [
  [409, 'VERSION_CONFLICT', /estado da etapa mudou/u],
  [422, 'OLIST_ORDER_INCOMPLETE', /não está completo/u],
  [409, 'OLIST_EXPORT_UNAVAILABLE', /Não há operação Olist/u],
  [429, 'OLIST_RATE_LIMITED', /Limite de consultas/u],
]) {
  test(`T13 reconcile ${failure[0]} ${failure[1]} is explained in Portuguese without provider text`, async ({
    page,
  }) => {
    const state = await setup(page, {
      viewer: 'admin',
      operation: op('uncertain', 'variation', {
        errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
      }),
      admin: uncertainVariationAdmin(),
      reconcileFailure: {
        status: Number(failure[0]),
        code: String(failure[1]),
      },
    });
    await open(page);
    await page
      .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
    await dialog
      .getByRole('button', { name: 'Solicitar conferência', exact: true })
      .click();
    await expect(dialog.getByRole('alert')).toHaveText(
      /** @type {RegExp} */ (failure[2]),
    );
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(page.getByText(canary)).toHaveCount(0);
    expect(countCalls(state, '/reconcile')).toBe(1);
    await expect(
      preparation(page).getByRole('button', { name: noRetry }),
    ).toHaveCount(0);
  });
}

test('T13 a 403 on a recovery command removes the administrative controls', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
    reconcileFailure: { status: 403, code: 'FORBIDDEN' },
  });
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
    .click();
  await page.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  await page
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.locator('.olist-recovery').getByRole('alert'),
  ).toContainText('Seu acesso mudou ou sua sessão expirou');
  await expect(
    page.getByRole('button', { name: /Conferir no Olist|Vincular venda/u }),
  ).toHaveCount(0);
});

test('T13 a 403 while loading the diagnosis hides every administrative control', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: op('queued', 'customer'),
    adminStatus: 403,
  });
  await open(page);
  await expect(
    page.locator('.olist-recovery').getByRole('alert'),
  ).toContainText('Seu acesso mudou');
  await expect(
    page.getByRole('button', { name: /Conferir no Olist|Vincular venda/u }),
  ).toHaveCount(0);
  // A leitura mínima do estado continua para quem está habilitado.
  await expect(stepLocator(page, 'customer')).toBeVisible();
});

test('T13 linking an existing sale takes two human gestures and never creates', async ({
  page,
}) => {
  const state = await setup(page, { viewer: 'admin', operation: null });
  await open(page);
  await expect(page.locator('.olist-progress')).toHaveCount(0);
  const trigger = page.getByRole('button', {
    name: 'Vincular venda existente',
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  const saleId = dialog.getByLabel('ID da venda no Olist');
  await expect(saleId).toBeFocused();
  // Formato inválido: erro sem chamada.
  await saleId.fill('abc-0');
  await dialog
    .getByRole('button', { name: 'Conferir venda', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText('somente números');
  await expect(saleId).toBeFocused();
  expect(countCalls(state, '/existing/previews')).toBe(0);
  // Escape devolve o foco ao acionador.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // Gesto 1: conferir.
  await trigger.click();
  await saleId.fill('9000');
  await page.keyboard.press('Enter');
  await expect(
    dialog.getByRole('heading', { name: 'Venda conferida' }),
  ).toBeFocused();
  expect(
    state.calls.find(({ path }) => path.endsWith('/existing/previews'))?.body,
  ).toEqual({ saleId: '9000' });
  await expect(dialog).toContainText('9000');
  await expect(dialog).not.toContainText(tokenCanary);
  expect(countCalls(state, '/links')).toBe(0);
  // Gesto 2: motivo e confirmação.
  const link = dialog.getByRole('button', {
    name: 'Vincular venda ao pedido',
    exact: true,
  });
  await link.click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Informe o motivo do vínculo.',
  );
  expect(countCalls(state, '/links')).toBe(0);
  await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
  await link.click();
  await expect(dialog).toHaveCount(0);
  const sent = state.calls.find(({ path }) => path.endsWith('/links'));
  expect(sent?.body).toEqual({ previewToken: tokenCanary, reason: REASON });
  expect(sent?.key).toMatch(/^[A-Za-z0-9._:-]{1,128}$/u);
  expect(sent?.csrf).toBe('t13-csrf');
  const progress = page.locator('.olist-progress');
  await expect(progress.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await expect(progress).toContainText(
    'Vinculada a uma venda que já existia no Olist',
  );
  await expect(
    progress.getByRole('heading', { name: 'Progresso no Olist' }),
  ).toBeFocused();
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'Venda Olist 9000 vinculada ao pedido. Nenhuma venda foi criada no Olist.',
  );
  // aria-busy on the region that holds the result announcement could silence it.
  await expect(page.locator('.olist-recovery')).not.toHaveAttribute(
    'aria-busy',
    /.*/u,
  );
  await expect(
    page.getByRole('button', { name: /Vincular venda|Conferir no Olist/u }),
  ).toHaveCount(0);
  expectNoCreation(state);
  expect(state.consoleTexts.join('\n')).not.toContain(tokenCanary);
  expect(await page.content()).not.toContain(tokenCanary);
});

test('T13 going back from the review discards the receipt and the same key is never reused with a new reason', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('resolving', 'customer'),
    linkFailure: { status: 503, code: 'OLIST_UNAVAILABLE' },
  });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist').fill('42');
  await dialog.getByRole('button', { name: 'Conferir venda' }).click();
  await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  // 5xx: the result is uncertain and the diagnosis was read again.
  await expect(dialog.getByRole('alert')).toContainText(
    'O resultado do vínculo é incerto e pode ter sido gravado',
  );
  await expect
    .poll(() => countCalls(state, '/administration', 'GET'))
    .toBeGreaterThanOrEqual(2);
  await dialog
    .getByLabel('Motivo do vínculo (obrigatório)')
    .fill(REASON + ' (revisado)');
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  const keys = state.calls
    .filter(({ path }) => path.endsWith('/links'))
    .map(({ key }) => key);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
  await dialog.getByRole('button', { name: 'Voltar' }).click();
  await expect(dialog.getByLabel('ID da venda no Olist')).toBeFocused();
  await expect(
    dialog.getByLabel('Motivo do vínculo (obrigatório)'),
  ).toHaveCount(0);
});

for (const failure of [
  ['links', 409, 'OLIST_PREVIEW_STALE', /mudou desde a conferência/u, true],
  [
    'links',
    409,
    'OLIST_SALE_REFERENCE_CONFLICT',
    /Nenhum vínculo foi criado/u,
    false,
  ],
  ['links', 422, 'OLIST_ORDER_INCOMPLETE', /não está completo/u, false],
  ['preview', 404, 'OLIST_RESOURCE_NOT_FOUND', /Venda não encontrada/u, false],
  [
    'preview',
    409,
    'OLIST_RECONCILIATION_REQUIRED',
    /vínculo manual não é permitido/u,
    false,
  ],
  ['preview', 422, 'OLIST_ORDER_INCOMPLETE', /não está completo/u, false],
]) {
  test(`T13 link ${failure[0]} ${failure[1]} ${failure[2]} is explained in Portuguese`, async ({
    page,
  }) => {
    const failureOption = {
      status: Number(failure[1]),
      code: String(failure[2]),
    };
    const state = await setup(page, {
      viewer: 'admin',
      operation: null,
      ...(failure[0] === 'links'
        ? { linkFailure: failureOption }
        : { previewFailure: failureOption }),
    });
    await open(page);
    await page
      .getByRole('button', { name: 'Vincular venda existente' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('ID da venda no Olist').fill('9000');
    await dialog.getByRole('button', { name: 'Conferir venda' }).click();
    if (failure[0] === 'links') {
      await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
      await dialog
        .getByRole('button', { name: 'Vincular venda ao pedido' })
        .click();
    }
    await expect(dialog.getByRole('alert')).toHaveText(
      /** @type {RegExp} */ (failure[3]),
    );
    await expect(dialog.getByRole('alert')).toBeFocused();
    await expect(page.getByText(canary)).toHaveCount(0);
    // Receipt stale/expired: volta ao primeiro gesto, nunca vincula.
    if (failure[4])
      await expect(dialog.getByLabel('ID da venda no Olist')).toBeVisible();
    expect(countCalls(state, '/links')).toBe(failure[0] === 'links' ? 1 : 0);
    expectNoCreation(state);
  });
}

test('T13 a 403 while previewing a link removes the administrative controls', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: null,
    previewFailure: { status: 403, code: 'FORBIDDEN' },
  });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  await page.getByLabel('ID da venda no Olist').fill('9000');
  await page.getByRole('button', { name: 'Conferir venda' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.locator('.olist-recovery').getByRole('alert'),
  ).toContainText('Seu acesso mudou');
  await expect(
    page.getByRole('button', { name: /Vincular venda/u }),
  ).toHaveCount(0);
});

test('T13 a double activation of Vincular venda sends exactly one link', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: null,
    gateLink: true,
  });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist').fill('9000');
  await dialog.getByRole('button', { name: 'Conferir venda' }).click();
  await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
  const link = dialog.getByRole('button', { name: 'Vincular venda ao pedido' });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => countCalls(state, '/links')).toBe(1);
  await dialog.locator('button.primary').dispatchEvent('click');
  await page.keyboard.press('Enter');
  state.releaseLink();
  await expect(dialog).toHaveCount(0);
  expect(countCalls(state, '/links')).toBe(1);
  expectNoCreation(state);
});

test('T13 two tabs: the second link of the same sale converges with 200 and shows the linked state', async ({
  page,
}) => {
  const state = await setup(page, { viewer: 'admin', operation: null });
  const other = await page.context().newPage();
  await open(page);
  await open(other);
  // Aba A vincula.
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  await page.getByLabel('ID da venda no Olist').fill('9000');
  await page.getByRole('button', { name: 'Conferir venda' }).click();
  // Aba B conferiu antes e vai vincular depois que A concluiu.
  await other.getByRole('button', { name: 'Vincular venda existente' }).click();
  await other.getByLabel('ID da venda no Olist').fill('9000');
  await other.getByRole('button', { name: 'Conferir venda' }).click();
  await page.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
  await page.getByRole('button', { name: 'Vincular venda ao pedido' }).click();
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await other.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
  await other.getByRole('button', { name: 'Vincular venda ao pedido' }).click();
  // The real contract: commitLink answers 200 with the receipt of the sale that
  // is already linked, so the stale tab converges instead of failing.
  await expect(other.getByRole('dialog')).toHaveCount(0);
  await expect(other.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await expect(other.locator('.olist-recovery-result')).toContainText(
    'Venda Olist 9000 vinculada ao pedido',
  );
  expect(countCalls(state, '/links')).toBe(2);
  await other.reload();
  await expect(other.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await expect(
    other.getByRole('button', { name: /Vincular venda existente/u }),
  ).toHaveCount(0);
  expectNoCreation(state);
});

test('T13 prefers-reduced-motion stops the active step pulse', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page, { operation: op('resolving', 'customer') });
  await open(page);
  const mark = stepLocator(page, 'customer').locator('.olist-step-mark');
  await expect(mark).toBeVisible();
  expect(
    await mark.evaluate(
      (node) => globalThis.getComputedStyle(node).animationName,
    ),
  ).toBe('none');
});

for (const viewport of [
  { width: 320, height: 760, name: 'mobile320' },
  { width: 390, height: 844, name: 'mobile390' },
  { width: 1366, height: 900, name: 'desktop1366' },
]) {
  test(`T13 recovery has axe, reflow and keyboard evidence ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const state = await setup(page, {
      viewer: 'admin',
      operation: op('uncertain', 'variation', {
        errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
      }),
      admin: uncertainVariationAdmin(),
    });
    await open(page);
    await expect(page.locator('.olist-recovery')).toBeVisible();
    await page.locator('details.olist-attempts summary').click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `var/olist-t13-recovery-${viewport.name}.png`,
      fullPage: true,
    });
    await page
      .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const box = await dialog.boundingBox();
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({
      path: `var/olist-t13-reconcile-dialog-${viewport.name}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(countCalls(state, '/reconcile')).toBe(0);
  });

  test(`T13 link review dialog and sent state have axe evidence ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const state = await setup(page, { viewer: 'admin', operation: null });
    await open(page);
    await page
      .getByRole('button', { name: 'Vincular venda existente' })
      .click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('ID da venda no Olist').fill('9000');
    await dialog.getByRole('button', { name: 'Conferir venda' }).click();
    await expect(
      dialog.getByRole('heading', { name: 'Venda conferida' }),
    ).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const box = await dialog.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
      viewport.width,
    );
    await page.screenshot({
      path: `var/olist-t13-link-dialog-${viewport.name}.png`,
    });
    await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
    await dialog
      .getByRole('button', { name: 'Vincular venda ao pedido' })
      .click();
    await expect(page.locator('.olist-progress-headline')).toHaveText(
      'Venda Olist conferida · Venda 9000',
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `var/olist-t13-sent-${viewport.name}.png`,
      fullPage: true,
    });
    expectNoCreation(state);
  });
}

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

/** @param {import('@playwright/test').Page} page */
const operationRead = (page) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === operationUrl &&
      response.request().method() === 'GET',
  );

const orderFixture = {
  ...pendingOrder,
  id: orderId,
  number: '41-CRM',
};
const openOrder = (/** @type {import('@playwright/test').Page} */ page) =>
  page.goto(`/pedidos/${orderId}`);

const newlineReason = 'Venda lançada\nmanualmente\tpela operadora';
const flatReason = 'Venda lançada manualmente pela operadora';
const controlCharacters = /[\u0000-\u001f\u007f]/u;

test('T13 a multiline reason is flattened before the reconcile command is sent', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
  });
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Motivo da conferência (obrigatório)')
    .fill(newlineReason);
  await dialog
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const sent = state.calls.find(({ path }) => path.endsWith('/reconcile'));
  expect(sent?.body.reason).toBe(flatReason);
  expect(sent?.body.reason).not.toMatch(controlCharacters);
});

test('T13 a multiline reason is flattened before the link command is sent', async ({
  page,
}) => {
  const state = await setup(page, { viewer: 'admin', operation: null });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist').fill('9000');
  await dialog.getByRole('button', { name: 'Conferir venda' }).click();
  await dialog
    .getByLabel('Motivo do vínculo (obrigatório)')
    .fill(newlineReason);
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect(dialog).toHaveCount(0);
  const sent = state.calls.find(({ path }) => path.endsWith('/links'));
  expect(sent?.body).toEqual({ previewToken: tokenCanary, reason: flatReason });
  expect(sent?.body.reason).not.toMatch(controlCharacters);
});

test('T13 a reason made only of line breaks is refused before any call', async ({
  page,
}) => {
  const state = await setup(page, { viewer: 'admin', operation: null });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist').fill('9000');
  await dialog.getByRole('button', { name: 'Conferir venda' }).click();
  await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill('\n\t\n');
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect(dialog.getByRole('alert')).toHaveText(
    'Informe o motivo do vínculo.',
  );
  expect(countCalls(state, '/links')).toBe(0);
});

test('T13 a 400 on a reason is explained without provider text', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
    reconcileFailure: { status: 400, code: 'INVALID_REQUEST' },
  });
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  await dialog
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'O motivo não pode ter quebra de linha',
  );
  await expect(page.getByText(canary)).toHaveCount(0);
});

test('T13 a live reset with the link dialog open keeps the dialog, the text and the focus, and applies the command in flight', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('queued', 'customer'),
    liveEvents: true,
    gateLink: true,
  });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist').fill('9000');
  await dialog.getByRole('button', { name: 'Conferir venda' }).click();
  const reason = dialog.getByLabel('Motivo do vínculo (obrigatório)');
  await reason.fill(REASON);
  await reason.focus();
  // A DOM mark: a remounted dialog would not carry it.
  await dialog.evaluate((node) => node.setAttribute('data-keep', '1'));

  await afterSessionRefresh(page, () => state.pushEvent('stream.reset', {}));
  await expect(page.locator('dialog[data-keep="1"]')).toBeVisible();
  await expect(reason).toHaveValue(REASON);
  await expect(reason).toBeFocused();

  // A command in flight across a second reset: its answer is applied.
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect.poll(() => countCalls(state, '/links')).toBe(1);
  await afterSessionRefresh(page, () => state.pushEvent('stream.reset', {}));
  await expect(page.locator('dialog[data-keep="1"]')).toBeVisible();
  state.releaseLink();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'Venda Olist 9000 vinculada ao pedido. Nenhuma venda foi criada no Olist.',
  );
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await expect(
    page
      .locator('.olist-progress')
      .getByRole('heading', { name: 'Progresso no Olist' }),
  ).toBeFocused();
  expect(countCalls(state, '/links')).toBe(1);
  expectNoCreation(state);
});

test('T13 a new order revision with the reconcile dialog open keeps the dialog and the text, and applies the command in flight', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
    order: orderFixture,
    liveEvents: true,
    gateReconcile: true,
  });
  await openOrder(page);
  const trigger = page.getByRole('button', {
    name: /^Conferir no Olist: Variação 4 de 5/u,
  });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /^Conferir Variação/u });
  const reason = dialog.getByLabel('Motivo da conferência (obrigatório)');
  await reason.fill(REASON);
  await dialog.evaluate((node) => node.setAttribute('data-keep', '1'));
  await dialog
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect.poll(() => countCalls(state, '/reconcile')).toBe(1);

  // Someone else edits the order: the revision changes while the POST is open.
  // Two Olist reads follow: one from the live event itself and one from the new
  // revision, which is the path that used to discard the panel.
  const before = countCalls(state, operationUrl, 'GET');
  state.order = { ...state.order, version: state.order.version + 1 };
  state.pushEvent('inbox.order.changed', { orderId });
  await expect
    .poll(() => countCalls(state, operationUrl, 'GET'))
    .toBeGreaterThanOrEqual(before + 2);
  await frames(page);
  await expect(page.locator('dialog[data-keep="1"]')).toBeVisible();
  await expect(reason).toHaveValue(REASON);

  state.releaseReconcile();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'solicitada. O resultado aparece em Conferências solicitadas',
  );
  await expect(trigger).toBeFocused();
  expect(countCalls(state, '/reconcile')).toBe(1);
});

test('T13 an administrator without the Olist checkbox keeps the progress and the recovery across session refreshes, with no generation control', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    enabled: false,
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
    order: orderFixture,
    liveEvents: true,
  });
  await openOrder(page);
  const generation = page.getByRole('button', {
    name: /Revisar envio|Enviar para Olist|Enviar para Olist/u,
  });
  const expectAdministration = async () => {
    await expect(page.locator('.olist-progress')).toBeVisible();
    await expect(page.locator('.olist-recovery')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: /^Conferir no Olist: Variação 4 de 5/u,
      }),
    ).toBeVisible();
    await expect(generation).toHaveCount(0);
    await expect(
      page.getByText(
        'Seu usuário não está habilitado para enviar pedidos ao Olist.',
      ),
    ).toBeVisible();
  };
  await expectAdministration();

  // A refresh that changes nothing does not even re-read the panel.
  const reads = countCalls(state, operationUrl, 'GET');
  await afterSessionRefresh(page, () =>
    state.pushEvent('identity.user.changed', { userId: state.viewer.id }),
  );
  await expectAdministration();
  expect(countCalls(state, operationUrl, 'GET')).toBe(reads);

  // A real change (authorization version) re-reads, and still nothing leaves.
  state.viewer.olistAuthorizationVersion += 1;
  const reread = operationRead(page);
  await afterSessionRefresh(page, () =>
    state.pushEvent('identity.user.changed', { userId: state.viewer.id }),
  );
  await reread;
  await frames(page);
  await expectAdministration();
  expect(countCalls(state, operationUrl, 'GET')).toBeGreaterThan(reads);
  expectNoCreation(state);
});

test('T13 the administrator counts move with the bounded CRM poll even when the state does not change, announcing the change', async ({
  page,
}) => {
  /** @param {number} confirmed */
  const resolvingAdmin = (confirmed) =>
    administration(op('resolving', 'variation'), {
      resources: [
        resource(customerId, 'customer', 'confirmed', 2, '100'),
        resource(productId, 'product', 'confirmed', 3, '200'),
        ...variationIds.map((id, index) =>
          resource(
            id,
            'variation',
            index < confirmed ? 'confirmed' : 'pending',
            index < confirmed ? 2 : 0,
            index < confirmed ? `30${index + 1}` : null,
            productId,
          ),
        ),
      ],
    });
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('resolving', 'variation'),
    admin: resolvingAdmin(3),
  });
  await open(page);
  await expect(stepLocator(page, 'product')).toContainText(
    '3 de 5 variações vinculadas',
  );
  const live = page.locator('.olist-progress [role="status"]');
  await expect(live).toHaveText('');
  // Same state and stage; only the count moves in the diagnosis.
  state.admin = resolvingAdmin(4);
  await expect(stepLocator(page, 'product')).toContainText(
    '4 de 5 variações vinculadas',
    { timeout: 12_000 },
  );
  await expect(live).toContainText('4 de 5 variações vinculadas');
  // Only the CRM is read: never an ERP lookup.
  expect(
    state.calls.filter(({ path }) =>
      /integrations\/olist\/(lookups|mappings)/u.test(path),
    ),
  ).toEqual([]);
  expectNoCreation(state);
});

/** @type {Array<[string, {errorCode: string}]>} */
const REJECTED_OPERATIONS = [
  ['customer', { errorCode: 'OLIST_UPSTREAM_REJECTED' }],
  ['sale', { errorCode: 'OLIST_UPSTREAM_REJECTED' }],
  ['sale', { errorCode: 'OLIST_SALE_UNCERTAIN' }],
];
for (const [stage, extra] of REJECTED_OPERATIONS) {
  test(`T13 a rejected ${stage} operation (${extra.errorCode}) is only informed: no link, no reconciliation of the sale`, async ({
    page,
  }) => {
    const rejected = op('rejected', stage, extra);
    const state = await setup(page, {
      viewer: 'admin',
      operation: rejected,
    });
    await open(page);
    await expect(page.locator('.olist-progress')).toBeVisible();
    await expect(page.locator('.olist-recovery')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: /Vincular venda existente|^Conferir no Olist: Venda/u,
      }),
    ).toHaveCount(0);
    expect(countCalls(state, '/links') + countCalls(state, '/reconcile')).toBe(
      0,
    );
  });
}

test('T13 an uncertain failure of the link re-reads the diagnosis and, if it was recorded, closes the dialog saying so', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: null,
    linkCommitsThenFails: { status: 503, code: 'OLIST_UNAVAILABLE' },
  });
  await open(page);
  await page.getByRole('button', { name: 'Vincular venda existente' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ID da venda no Olist').fill('9000');
  await dialog.getByRole('button', { name: 'Conferir venda' }).click();
  await dialog.getByLabel('Motivo do vínculo (obrigatório)').fill(REASON);
  await dialog
    .getByRole('button', { name: 'Vincular venda ao pedido' })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'O vínculo foi gravado, apesar da falha na resposta. Nenhuma venda foi criada no Olist.',
  );
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  await expect(page.getByText(canary)).toHaveCount(0);
  expect(countCalls(state, '/links')).toBe(1);
  expectNoCreation(state);
});

test('T13 an uncertain failure of the reconcile re-reads the diagnosis and says the request may exist', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin: uncertainVariationAdmin(),
    reconcileFailure: { status: 502, code: 'BAD_GATEWAY' },
  });
  await open(page);
  await page
    .getByRole('button', { name: /^Conferir no Olist: Variação 4 de 5/u })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  await dialog
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'O resultado da solicitação é incerto e pode ter sido registrado',
  );
  await expect
    .poll(() => countCalls(state, '/administration', 'GET'))
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => countCalls(state, operationUrl, 'GET'))
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByText(canary)).toHaveCount(0);
  expect(countCalls(state, '/reconcile')).toBe(1);
});

test('T13 the focus moves to the result title when the follow-up removes the button that had it', async ({
  page,
}) => {
  const admin = uncertainVariationAdmin();
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('uncertain', 'variation', {
      errorCode: 'OLIST_RESOURCE_OUTCOME_UNKNOWN',
    }),
    admin,
  });
  await open(page);
  const trigger = page.getByRole('button', {
    name: /^Conferir no Olist: Variação 4 de 5/u,
  });
  await trigger.click();
  await page.getByLabel('Motivo da conferência (obrigatório)').fill(REASON);
  await page
    .getByRole('button', { name: 'Solicitar conferência', exact: true })
    .click();
  await expect(trigger).toBeFocused();
  // The persisted result arrives with the resource confirmed.
  state.requestStatus = 'succeeded';
  state.operation = op('resolving', 'variation');
  state.admin = administration(op('resolving', 'variation'), {
    resources: admin.resources.map((/** @type {any} */ item) =>
      item.id === variationIds[3]
        ? { ...item, state: 'confirmed', version: 5, remoteId: '304' }
        : item,
    ),
  });
  await expect(page.locator('.olist-recovery-result')).toContainText(
    'concluída. O progresso foi atualizado.',
    { timeout: 10_000 },
  );
  await expect(trigger).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Conferências solicitadas' }),
  ).toBeFocused();
});

test('T13 live events about other orders neither alert nor reset an operation underway', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('queued', 'customer'),
    liveEvents: true,
  });
  await open(page);
  await expect(stepLocator(page, 'customer')).toHaveAttribute(
    'data-status',
    'waiting',
  );
  // An alert that appears and is cleared by the next read would escape a plain
  // count, so every alert that ever shows is recorded.
  await page.evaluate(() => {
    /** @type {string[]} */
    const seen = [];
    Object.defineProperty(globalThis, '__alerts', { value: seen });
    new globalThis.MutationObserver(() => {
      for (const node of globalThis.document.querySelectorAll(
        '[role="alert"]',
      )) {
        const text = (node.textContent ?? '').trim();
        if (text) seen.push(text);
      }
    }).observe(globalThis.document.body, {
      characterData: true,
      childList: true,
      subtree: true,
    });
  });
  const reads = () => countCalls(state, operationUrl, 'GET');
  const before = reads();
  state.pushEvent('inbox.order.changed', {
    orderId: '8c7ba95a-8b94-4dcb-a71d-3b73a663a778',
  });
  state.pushEvent('inbox.contact.changed', { contactId: 'contact-synthetic' });
  // The last event is about this order: it only re-reads, and being processed
  // after the two above it proves they were handled (and ignored).
  state.pushEvent('inbox.order.changed', { orderId });
  await expect.poll(reads).toBe(before + 1);
  await frames(page);
  expect(
    await page.evaluate(() => /** @type {any} */ (globalThis).__alerts),
  ).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(stepLocator(page, 'customer')).toHaveAttribute(
    'data-status',
    'waiting',
  );
  expect(reads()).toBe(before + 1);
});

test('T13 a finished operation re-reads on its own order event without asking for a new preview', async ({
  page,
}) => {
  const state = await setup(page, {
    viewer: 'admin',
    operation: op('linked', 'complete', { number: '9000' }),
    liveEvents: true,
  });
  await open(page);
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
  const before = countCalls(state, operationUrl, 'GET');
  state.pushEvent('inbox.order.changed', { orderId });
  await expect
    .poll(() => countCalls(state, operationUrl, 'GET'))
    .toBe(before + 1);
  await frames(page);
  await expect(
    page.getByText(/Os dados ou o acesso podem ter mudado/u),
  ).toHaveCount(0);
  await expect(page.locator('.olist-progress-headline')).toHaveText(
    'Venda Olist conferida · Venda 9000',
  );
});

test('T13 cancelling the order on its page removes the preview, the conference and the link controls', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: null,
    order: orderFixture,
  });
  await openOrder(page);
  const controls = page.getByRole('button', {
    name: /Revisar envio|Vincular venda existente/u,
  });
  await expect(controls).toHaveCount(2);
  await page
    .getByRole('button', { name: 'Cancelar pedido', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Cancelar o pedido 41-CRM?',
  });
  await dialog.getByLabel('Motivo do cancelamento').fill('Cliente desistiu');
  await dialog.getByRole('button', { name: 'Cancelar pedido 41-CRM' }).click();
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  await expect(controls).toHaveCount(0);
  const panel = page.locator('.olist-preparation');
  await expect(panel).toContainText(
    'Pedido cancelado. A geração está bloqueada.',
  );
  await expect(
    panel.getByRole('button', { name: /Enviar para Olist|Enviar para Olist/u }),
  ).toHaveCount(0);
  await expect(panel.locator('.olist-recovery')).toContainText(
    'A conferência e o vínculo estão bloqueados',
  );
});

test('T13 an order already cancelled opens with no preview, conference or link controls but keeps the history', async ({
  page,
}) => {
  const admin = uncertainVariationAdmin();
  await setup(page, {
    viewer: 'admin',
    operation: op('invalidated', 'customer'),
    admin: administration(op('invalidated', 'customer'), {
      resources: admin.resources,
      attempts: admin.attempts,
    }),
    order: {
      ...orderFixture,
      cancelledAt: '2026-11-08T14:00:00.000Z',
      cancelledBy: { id: 'seller-marina', name: 'Marina Aguiar' },
      cancellationReason: 'Pedido duplicado',
      effectiveStatus: 'cancelado',
      version: 5,
    },
  });
  await openOrder(page);
  await expect(page.locator('.op-status')).toHaveText('Cancelado');
  const panel = page.locator('.olist-preparation');
  await expect(panel).toContainText(
    'Pedido cancelado. A geração está bloqueada.',
  );
  await expect(
    panel.getByRole('button', {
      name: /Revisar envio|Vincular venda|Conferir no Olist|Enviar para Olist/u,
    }),
  ).toHaveCount(0);
  // The read-only history is still there.
  await expect(panel.locator('.olist-progress')).toBeVisible();
  await expect(panel.locator('details.olist-attempts')).toBeVisible();
});

test('T13 the Olist page blocks the controls for an order its lookup reported as cancelled', async ({
  page,
}) => {
  await setup(page, {
    viewer: 'admin',
    operation: null,
    lookup: {
      orderId,
      number: '41-CRM',
      status: 'cancelado',
      pendingFields: [],
      operation: null,
    },
  });
  await page.goto('/olist');
  await page.getByLabel('Número ou identificador do pedido').fill('41-CRM');
  await page.getByRole('button', { name: 'Localizar pedido' }).click();
  await page.getByRole('link', { name: 'Conferir pedido no Olist' }).click();
  const panel = page.locator('.olist-preparation');
  await expect(panel).toContainText(
    'Pedido cancelado. A geração está bloqueada.',
  );
  await expect(
    panel.getByRole('button', {
      name: /Revisar envio|Vincular venda|Enviar para Olist/u,
    }),
  ).toHaveCount(0);
});
