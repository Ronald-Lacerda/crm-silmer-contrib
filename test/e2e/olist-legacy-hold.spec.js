import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mockOrders, pendingOrder } from './support/orders-mock.js';

// The entire API is synthetic. The withdrawal is a local audited command;
// unknown requests, including preview/export/provider writes, are refused.
const orderId = '66666666-6666-4666-8666-666666666661';
const operationId = '66666666-6666-4666-8666-666666666662';
const base = `/api/v1/orders/${orderId}/olist`;
const reason = 'Retirada local sintética para conferência humana';

/** @param {import('@playwright/test').Page} page @param {{admin?:boolean,hold?:boolean,flag?:boolean,resources?:any[],attempts?:any[],failure?:{status:number,code:string},lostAnswer?:boolean,wrongReceipt?:boolean}} [options] */
async function setup(page, options = {}) {
  const admin = options.admin ?? true;
  const user = {
    id: 'hold-reviewer',
    name: 'Pessoa sintética',
    functionName: admin ? 'Administrador' : 'Vendedor',
    capabilities: admin ? ['COMMERCIAL_ADMIN'] : [],
    olistEnabled: !admin,
    olistAuthorizationVersion: 2,
  };
  await mockOrders(page, {
    orders: [{ ...pendingOrder, id: orderId, number: '74-CRM' }],
    user,
  });
  await page
    .context()
    .addCookies([
      { name: 'crm_csrf', value: 'hold-csrf', url: 'http://127.0.0.1:4173' },
    ]);
  /** @type {Array<{path:string,method:string,body:any,headers:Record<string,string>}>} */ const calls =
    [];
  let held = options.hold ?? false;
  const diagnostic = () => ({
    operation: {
      id: operationId,
      state: held ? 'legacy_review_required' : 'linked',
      stage: 'complete',
      number: '98',
      version: held ? 8 : 7,
      errorCode: held ? 'OLIST_LEGACY_REVIEW_REQUIRED' : null,
      canWithdrawLegacyLink: held ? false : (options.flag ?? true),
    },
    resources: options.resources ?? [],
    attempts: options.attempts ?? [],
    requests: [],
    legacyLinkContext: null,
  });
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname,
      method = req.method(),
      body = method === 'POST' ? req.postDataJSON() : null;
    calls.push({ path, method, body, headers: req.headers() });
    const json = (/** @type {unknown} */ value, status = 200) =>
      route.fulfill({ status, json: value });
    if (path === '/api/v1/sessions/current') return json({ user });
    if (path === '/api/v1/events')
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n',
      });
    if (path === '/api/v1/integrations/olist/status')
      return json({
        configured: false,
        connected: false,
        creationEnabled: false,
      });
    if (path === base && method === 'GET') {
      const current = diagnostic().operation;
      return json({
        orderId,
        number: '74-CRM',
        status: 'pendente',
        creationEnabled: false,
        paymentDuePolicy: 'erp',
        operation: {
          state: current.state,
          stage: current.stage,
          number: current.number,
          errorCode: current.errorCode,
        },
        pendingFields: [],
      });
    }
    if (path === `${base}/administration`) return json(diagnostic());
    if (path === `${base}/invalidate` && method === 'POST') {
      expect(body).toEqual({ operationId, expectedVersion: 7, reason });
      if (options.failure)
        return json(
          { code: options.failure.code, detail: 'PRIVATE_PROVIDER_BODY' },
          options.failure.status,
        );
      if (options.wrongReceipt)
        return json({ operationId, state: 'invalidated', version: 8 });
      held = true;
      if (options.lostAnswer) return json({ code: 'SERVICE_UNAVAILABLE' }, 503);
      return json({
        operationId,
        orderId,
        state: 'legacy_review_required',
        version: 8,
      });
    }
    if (path.startsWith(base)) return json({ code: 'FORBIDDEN' }, 403);
    return route.fallback();
  });
  await page.goto(admin ? `/pedidos/${orderId}` : `/olist?pedido=${orderId}`);
  return { calls };
}

/** @param {import('@playwright/test').Page} page */
const withdrawal = (page) =>
  page.getByRole('button', { name: 'Retirar vínculo histórico', exact: true });
/** @param {import('@playwright/test').Page} page */
const dialog = (page) =>
  page.getByRole('dialog', { name: 'Retirar vínculo histórico?', exact: true });
/** @param {{calls:Array<{path:string,method:string}>}} state */
function expectNoERPCommands(state) {
  expect(
    state.calls.filter(
      (call) => call.method === 'POST' && call.path !== `${base}/invalidate`,
    ),
  ).toEqual([]);
}

/** @param {import('@playwright/test').Page} page */
async function expectProtected(page) {
  await expect(page.locator('.olist-progress-headline')).toContainText(
    'Venda histórica aguarda conferência',
  );
  await expect(page.locator('.olist-progress-headline')).toContainText(
    'Venda 98',
  );
  await expect(page.locator('.olist-progress-guidance')).toContainText(
    'Novo envio bloqueado para evitar duplicidade',
  );
  await expect(
    page.getByRole('button', {
      name: /Revisar envio|^Enviar para Olist$|Vincular venda|Conferir no Olist|Retirar vínculo histórico|Invalidar esta geração/u,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByText(/Gere uma nova prévia|Na fila para iniciar/u),
  ).toHaveCount(0);
}

test('T16 only an administrator can withdraw an isolated historical link while keeping the existing ERP sale protected', async ({
  page,
}) => {
  const state = await setup(page);
  await withdrawal(page).focus();
  await page.keyboard.press('Enter');
  const review = dialog(page);
  await expect(review).toBeVisible();
  const field = review.getByLabel('Motivo da retirada (obrigatório)');
  await expect(field).toBeFocused();
  await expect(review).toContainText('Somente o vínculo local');
  await expect(review).toContainText('Olist permanecem intactos');
  await expect(review).toContainText('bloqueado para evitar duplicidade');
  await review
    .getByRole('button', { name: 'Retirar vínculo histórico', exact: true })
    .click();
  await expect(field).toBeFocused();
  expect(state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  await field.fill(reason);
  await review
    .getByRole('button', { name: 'Retirar vínculo histórico', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(review).toHaveCount(0);
  await expectProtected(page);
  await expect(
    page.getByRole('heading', { name: 'Progresso no Olist' }),
  ).toBeFocused();
  const commands = state.calls.filter(
    (call) => call.path === `${base}/invalidate`,
  );
  expect(commands).toHaveLength(1);
  expect(commands[0].headers['x-csrf-token']).toBe('hold-csrf');
  expect(commands[0].headers['idempotency-key']).toBeTruthy();
  expectNoERPCommands(state);
  await page.reload();
  await expectProtected(page);
  expectNoERPCommands(state);
});

test('T16 the seller sees the protected history without administration or a duplicate sending action', async ({
  page,
}) => {
  const state = await setup(page, { admin: false, hold: true });
  await expectProtected(page);
  await expect(
    page.getByRole('heading', { name: 'Conferência administrativa' }),
  ).toHaveCount(0);
  expect(
    state.calls.filter((call) => call.path.endsWith('/administration')),
  ).toHaveLength(0);
  await page
    .getByRole('button', { name: 'Atualizar progresso', exact: true })
    .click();
  await expectProtected(page);
  expect(state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
});

for (const variant of [
  { label: 'canonical link', flag: false },
  {
    label: 'existing resource',
    resources: [
      {
        id: 'resource-test',
        kind: 'customer',
        state: 'confirmed',
        version: 1,
        remoteId: '100',
      },
    ],
  },
  {
    label: 'previous attempt',
    attempts: [
      {
        id: 'attempt-test',
        stage: 'customer',
        outcome: 'confirmed',
        createdAt: '2026-11-09T12:00:00Z',
      },
    ],
  },
]) {
  test(`T16 withdrawal is not offered for ${variant.label}`, async ({
    page,
  }) => {
    const state = await setup(page, variant);
    await expect(
      page.getByRole('heading', { name: 'Conferência administrativa' }),
    ).toBeVisible();
    await expect(withdrawal(page)).toHaveCount(0);
    expect(state.calls.filter((call) => call.method === 'POST')).toHaveLength(
      0,
    );
  });
}

test('T16 a protected hold never offers reconciliation even with a stale resource in the diagnosis', async ({
  page,
}) => {
  const state = await setup(page, {
    hold: true,
    resources: [
      {
        id: 'resource-test',
        kind: 'customer',
        state: 'uncertain',
        version: 1,
        remoteId: null,
      },
    ],
  });
  await expect(
    page.getByRole('heading', { name: 'Conferência administrativa' }),
  ).toBeVisible();
  await expectProtected(page);
  expectNoERPCommands(state);
});

test('T16 closing the withdrawal dialog restores focus without a command', async ({
  page,
}) => {
  const state = await setup(page);
  await withdrawal(page).click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect(withdrawal(page)).toBeFocused();
  expect(state.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
});

test('T16 a refused withdrawal keeps the existing link and a safe focused explanation', async ({
  page,
}) => {
  const state = await setup(page, {
    failure: { status: 409, code: 'OLIST_INVALIDATION_BLOCKED' },
  });
  await withdrawal(page).click();
  await dialog(page)
    .getByLabel('Motivo da retirada (obrigatório)')
    .fill(reason);
  await dialog(page)
    .getByRole('button', { name: 'Retirar vínculo histórico', exact: true })
    .click();
  await expect(dialog(page).getByRole('alert')).toBeFocused();
  await expect(page.getByText('PRIVATE_PROVIDER_BODY')).toHaveCount(0);
  await expect(
    dialog(page).getByLabel('Motivo da retirada (obrigatório)'),
  ).toHaveValue(reason);
  expectNoERPCommands(state);
});

test('T16 a lost withdrawal response is accepted only after the diagnosis confirms the protected hold', async ({
  page,
}) => {
  const state = await setup(page, { lostAnswer: true });
  await withdrawal(page).click();
  await dialog(page)
    .getByLabel('Motivo da retirada (obrigatório)')
    .fill(reason);
  await dialog(page)
    .getByRole('button', { name: 'Retirar vínculo histórico', exact: true })
    .click();
  await expect(dialog(page)).toHaveCount(0);
  await expectProtected(page);
  expect(
    state.calls.filter((call) => call.path === `${base}/invalidate`),
  ).toHaveLength(1);
  expectNoERPCommands(state);
});

test('T16 an ordinary invalidated receipt is not proof that a historical link has been safely withdrawn', async ({
  page,
}) => {
  const state = await setup(page, { wrongReceipt: true });
  await withdrawal(page).click();
  await dialog(page)
    .getByLabel('Motivo da retirada (obrigatório)')
    .fill(reason);
  await dialog(page)
    .getByRole('button', { name: 'Retirar vínculo histórico', exact: true })
    .click();
  await expect(dialog(page).getByRole('alert')).toBeFocused();
  await expect(dialog(page).getByRole('alert')).toContainText(
    'não confirmou a retirada',
  );
  expectNoERPCommands(state);
});

for (const viewport of [
  { name: 'mobile320', width: 320, height: 780 },
  { name: 'desktop1366', width: 1366, height: 900 },
]) {
  test(`T16 withdrawal and protected hold have keyboard and axe evidence ${viewport.name}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const state = await setup(page);
    await withdrawal(page).click();
    const review = dialog(page);
    await expect(review).toBeVisible();
    expect(
      (await new AxeBuilder({ page }).include('dialog').analyze()).violations,
    ).toEqual([]);
    await page.screenshot({
      path: `var/qa-olist-phase6/legacy-withdraw-${viewport.name}.png`,
    });
    await review.getByLabel('Motivo da retirada (obrigatório)').fill(reason);
    await review
      .getByRole('button', { name: 'Retirar vínculo histórico', exact: true })
      .click();
    await expectProtected(page);
    await expect(
      page.getByRole('heading', { name: 'Progresso no Olist' }),
    ).toBeFocused();
    expect(
      (await new AxeBuilder({ page }).include('.olist-preparation').analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page
        .locator('.olist-preparation')
        .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
    ).toBe(true);
    await page.locator('.olist-progress-guidance').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `var/qa-olist-phase6/legacy-hold-${viewport.name}.png`,
    });
    expectNoERPCommands(state);
  });
}
