import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const base = '/api/v1/integrations/olist';
const settings = {
  sellerId: null,
  operationNatureId: null,
  warehouseId: null,
  paymentMethodId: null,
  priceListId: null,
  originId: null,
  paymentTerms: null,
  purchaseOrder: null,
};
const resourceId = '7fbb479b-65c0-4b74-ae0b-daf8bdce1a96';
const connected = {
  configured: true,
  accountConfigured: true,
  connected: true,
  reconnectRequired: false,
  creationEnabled: false,
  version: 3,
  generation: 2,
  settingsVersion: 4,
  settings,
  environment: 'production',
  expiresAt: null,
};

/** @param {import('@playwright/test').Page} page @param {{profile?:string,enabled?:boolean,conflict?:boolean,initialStatus?:any,failures?:Record<string,{code:string,status:number}>,catalogItems?:any[],mappingState?:string,authorizationUrl?:string}} [options] */
async function setup(page, options = {}) {
  const viewer = {
    id: 'viewer',
    name: 'Operador de exemplo',
    email: 'operador@example.test',
    functionName: options.profile === 'finance' ? 'Financeiro' : 'Vendedor',
    capabilities: options.profile === 'admin' ? ['COMMERCIAL_ADMIN'] : [],
    olistEnabled: options.enabled ?? true,
    olistAuthorizationVersion: 2,
  };
  const target = {
    id: 'target',
    name: 'Pessoa financeira de exemplo',
    email: 'financeiro@example.test',
    functionName: 'Financeiro',
    capabilities: [],
    olistEnabled: false,
    olistAuthorizationVersion: 7,
    disabledAt: null,
  };
  /** @type {Array<{path:string,body:any,url:string}>} */
  const calls = [];
  let current = {
    ...connected,
    settings: { ...settings },
    ...options.initialStatus,
  };
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  await page.context().addCookies([
    {
      name: 'crm_csrf',
      value: 'olist-test-csrf',
      url: 'http://127.0.0.1:4173',
    },
  ]);
  await page.route('**/api/v1/**', async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = ['POST', 'PATCH'].includes(req.method())
      ? req.postDataJSON()
      : null;
    calls.push({ path, body, url: page.url() });
    const json = (/** @type {unknown} */ value, code = 200) =>
      route.fulfill({
        contentType: 'application/json',
        status: code,
        body: JSON.stringify(value),
      });
    if (path === '/api/v1/sessions/current') return json({ user: viewer });
    if (path === '/api/v1/events') {
      await eventGate;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `retry: 60000\n\nevent: identity.user.changed\nid: olist-revoke\ndata: {"userId":"viewer"}\n\n`,
      });
    }
    if (path === '/api/v1/orders/summary') return json({ storeNewCount: 0 });
    const failure = options.failures?.[path.slice(base.length + 1)];
    if (failure)
      return json(
        { code: failure.code, detail: 'private-provider-detail-canary' },
        failure.status,
      );
    if (path === `${base}/status`) return json(current);
    if (path.startsWith(`${base}/`) && req.method() === 'POST') {
      expect(req.headers()['x-csrf-token']).toBe('olist-test-csrf');
      if (path !== `${base}/complete`)
        expect(req.headers()['idempotency-key']).toBeTruthy();
      if (path === `${base}/order-lookup`)
        return json({
          orderId: 'acbf1c1b-c57f-4c5c-8076-7f439f95cfb0',
          number: '41-CRM',
          status: 'pendente',
          pendingFields: [
            { code: 'CUSTOMER_FISCAL', label: 'Cadastro fiscal incompleto' },
          ],
          operation: null,
          creationEnabled: false,
        });
      if (path === `${base}/complete`) return json(current);
      if (path === `${base}/recovery`) {
        current = {
          ...current,
          recoveryRequired: false,
          version: current.version + 1,
        };
        return json(current);
      }
      if (path === `${base}/creation`) {
        current = {
          ...current,
          creationActive: body.enabled,
          creationEnabled: body.enabled,
          version: current.version + 1,
        };
        return json(current);
      }
      if (path === `${base}/lookups`)
        return json({
          items: options.catalogItems ?? [
            { id: 23, name: 'Referência sintética' },
          ],
        });
      if (path === `${base}/mappings`)
        return json({
          id: resourceId,
          kind: 'variation',
          state: options.mappingState ?? 'confirmed',
          remoteId: '501',
        });
      if (path === `${base}/settings`) {
        current = {
          ...current,
          settings: body.settings,
          settingsVersion: current.settingsVersion + 1,
        };
        return json(current);
      }
      if (path === `${base}/disconnect`) {
        current = { ...current, connected: false };
        return json(current);
      }
      if (path === `${base}/authorize`)
        return json({
          authorizationUrl:
            options.authorizationUrl ?? 'https://unexpected.example.test/oauth',
        });
    }
    if (path === '/api/v1/users' && req.method() === 'GET')
      return json({ users: [viewer, target] });
    if (path === '/api/v1/users/target' && req.method() === 'PATCH') {
      expect(req.headers()['idempotency-key']).toBeTruthy();
      if (options.conflict) return json({ code: 'VERSION_CONFLICT' }, 409);
      target.olistEnabled = body.olistEnabled;
      target.olistAuthorizationVersion++;
      return json({ user: target });
    }
    if (path === '/api/v1/finance/orders')
      return json({
        items: [],
        counts: { waiting: 0, completed: 0 },
        nextCursor: null,
      });
    return json({
      columns: [],
      items: [],
      eventCursor: 'olist-before',
      period: {},
      totals: {},
      mine: {},
      team: [],
    });
  });
  return {
    calls,
    /** @param {any} next */
    setStatus(next) {
      current = { ...current, ...next };
    },
    revokeManagement() {
      viewer.capabilities = [];
      releaseEvent();
    },
    revoke() {
      viewer.olistEnabled = false;
      viewer.olistAuthorizationVersion++;
      releaseEvent();
    },
  };
}

test('enabled Financeiro searches exactly by keyboard with a minimum projection and no commercial access', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'finance' });
  await page.goto('/olist');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Olist' }),
  ).toBeFocused();
  await expect(
    page.getByRole('link', { name: 'Caixa de Entrada', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Conexão da empresa' }),
  ).toHaveCount(0);
  await page.getByLabel('Número ou identificador do pedido').fill('41-CRM');
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Pedido 41-CRM' }),
  ).toBeFocused();
  await expect(page.getByText('Cadastro fiscal incompleto')).toBeVisible();
  await expect(page.getByRole('link', { name: /Pedido 41/u })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Gerar/u })).toHaveCount(0);
  expect(
    calls.find((call) => call.path === `${base}/order-lookup`)?.body,
  ).toEqual({ query: '41-CRM' });
  expect(
    calls.filter(
      (call) =>
        call.path === `${base}/status` ||
        call.path === '/api/v1/orders' ||
        call.path === '/api/v1/contacts',
    ),
  ).toHaveLength(0);
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  await page.screenshot({
    path: 'var/olist-finance-desktop.png',
    fullPage: true,
  });
  await page.goto('/inbox');
  await expect(page).toHaveURL('/financeiro');
});

test('T17 admin activates and stops the restricted pilot with an explicit reason', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: { pilotConfigured: true, recoveryRequired: false },
  });
  await page.goto('/olist');
  await page.getByText('Geração no piloto', { exact: true }).click();
  const enable = page.getByRole('button', {
    name: 'Ativar geração no piloto',
    exact: true,
  });
  await expect(enable).toBeDisabled();
  await page
    .getByLabel('Motivo da alteração')
    .fill('Iniciar amostra controlada aprovada');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'var/olist-pilot-mobile.png', fullPage: true });
  await enable.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Olist', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText('Geração ativada.', { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Motivo da alteração')
    .fill('Encerrar amostra para conferência');
  await page
    .getByRole('button', { name: 'Desativar geração', exact: true })
    .click();
  await expect(
    page.getByText('Geração desativada.', { exact: true }),
  ).toBeVisible();
  const writes = calls.filter((call) => call.path === `${base}/creation`);
  expect(writes.map((call) => call.body)).toEqual([
    {
      enabled: true,
      expectedVersion: 3,
      reason: 'Iniciar amostra controlada aprovada',
    },
    {
      enabled: false,
      expectedVersion: 4,
      reason: 'Encerrar amostra para conferência',
    },
  ]);
});

test('T17 recovery blocks activation while stopping remains available', async ({
  page,
}) => {
  await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: {
      pilotConfigured: true,
      recoveryRequired: true,
    },
  });
  await page.goto('/olist');
  await page.getByText('Geração no piloto', { exact: true }).click();
  await page.getByLabel('Motivo da alteração').fill('Conferência em andamento');
  await expect(
    page.getByRole('button', { name: 'Ativar geração no piloto', exact: true }),
  ).toBeDisabled();
});

test('T17 admin stops an active pilot even when its connection is unavailable', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: {
      creationActive: true,
      creationEnabled: false,
      connected: false,
      reconnectRequired: true,
      pilotConfigured: false,
      recoveryRequired: true,
    },
  });
  await page.goto('/olist');
  await page.getByText('Geração no piloto', { exact: true }).click();
  await page
    .getByLabel('Motivo da alteração')
    .fill('Interromper durante a reconexão');
  await page
    .getByRole('button', { name: 'Desativar geração', exact: true })
    .click();
  expect(
    calls
      .filter((call) => call.path === `${base}/creation`)
      .map((call) => call.body),
  ).toEqual([
    {
      enabled: false,
      expectedVersion: 3,
      reason: 'Interromper durante a reconexão',
    },
  ]);
});

test('T15 recovery requires explicit human attestation and does not activate creation', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: {
      creationActive: false,
      creationEnabled: false,
      pilotConfigured: true,
      recoveryRequired: true,
    },
  });
  await page.goto('/olist');
  await page.getByText('Geração no piloto', { exact: true }).click();
  const finish = page.getByRole('button', {
    name: 'Registrar conferência concluída',
    exact: true,
  });
  await expect(finish).toBeDisabled();
  await page
    .getByLabel('Motivo da conferência')
    .fill('Conferência inicial documentada');
  await expect(finish).toBeDisabled();
  await page
    .getByLabel(
      'Conferi os cadastros e as vendas existentes, inclusive a janela de recuperação.',
    )
    .check();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: 'var/olist-recovery-admin.png',
    fullPage: true,
  });
  await finish.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByText('Conferência registrada. A geração continua desativada.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByText('Geração desativada.', { exact: true }),
  ).toBeVisible();
  expect(
    calls
      .filter((call) => call.path === `${base}/recovery`)
      .map((call) => call.body),
  ).toEqual([
    {
      expectedVersion: 3,
      confirmed: true,
      reason: 'Conferência inicial documentada',
    },
  ]);
  expect(calls.filter((call) => call.path === `${base}/creation`)).toHaveLength(
    0,
  );
});

test('T15 pending recovery keeps the declaration and reason with safe focused feedback', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: { recoveryRequired: true, creationActive: false },
    failures: { recovery: { code: 'OLIST_RECOVERY_BLOCKED', status: 409 } },
  });
  await page.goto('/olist');
  await page.getByText('Geração no piloto', { exact: true }).click();
  const reason = page.getByLabel('Motivo da conferência');
  await reason.fill('Conferência ainda em análise');
  const declaration = page.getByLabel(
    'Conferi os cadastros e as vendas existentes, inclusive a janela de recuperação.',
  );
  await declaration.check();
  await page
    .getByRole('button', {
      name: 'Registrar conferência concluída',
      exact: true,
    })
    .click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('alert')).toContainText(
    'operações pendentes ou divergentes',
  );
  await expect(reason).toHaveValue('Conferência ainda em análise');
  await expect(declaration).toBeChecked();
  await expect(page.locator('body')).not.toContainText(
    'private-provider-detail-canary',
  );
  expect(calls.filter((call) => call.path === `${base}/creation`)).toHaveLength(
    0,
  );
});

test('lookup refuses incomplete numbers and remains usable on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { calls } = await setup(page, { profile: 'finance' });
  await page.goto('/olist');
  await page.getByLabel('Número ou identificador do pedido').fill('41');
  await page
    .getByRole('button', { name: 'Localizar pedido', exact: true })
    .click();
  await expect(page.getByRole('alert')).toBeFocused();
  expect(
    calls.filter((call) => call.path === `${base}/order-lookup`),
  ).toHaveLength(0);
  await page.getByLabel('Número ou identificador do pedido').fill('41-CRM');
  await page
    .getByRole('button', { name: 'Localizar pedido', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Pedido 41-CRM' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  const mobileNav = await page
    .getByRole('navigation', { name: 'Navegação móvel' })
    .boundingBox();
  expect(mobileNav?.height).toBeLessThanOrEqual(80);
  await page.screenshot({
    path: 'var/olist-finance-mobile.png',
    fullPage: true,
  });
});

test('disabled Admin manages the connection without order lookup or self-enablement', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Localizar pedido' }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Conectar Olist', exact: false })
    .first()
    .click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page).toHaveURL('/olist');
  expect(
    calls.filter((call) => call.path === `${base}/order-lookup`),
  ).toHaveLength(0);
  await page.goto('/usuarios');
  await expect(
    page.getByLabel('Habilitado Olist', { exact: true }),
  ).not.toBeChecked();
  await page.getByLabel('Mais ações para Operador de exemplo').click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByLabel('Habilitado Olist'),
  ).toBeDisabled();
});

test('administrator enables an unrelated Financeiro with its current authorization version', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/usuarios');
  await page.getByLabel('Mais ações para Pessoa financeira de exemplo').click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const checkbox = page.getByRole('dialog').getByLabel('Habilitado Olist');
  await expect(checkbox).not.toBeChecked();
  await checkbox.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    calls.find((call) => call.path === '/api/v1/users/target')?.body,
  ).toMatchObject({ olistEnabled: true, expectedOlistAuthorizationVersion: 7 });
});

test('stale Olist checkbox keeps editing open and explains the conflict', async ({
  page,
}) => {
  await setup(page, { profile: 'admin', enabled: false, conflict: true });
  await page.goto('/usuarios');
  await page.getByLabel('Mais ações para Pessoa financeira de exemplo').click();
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Habilitado Olist').check();
  await page.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(
    page.getByText(/habilitação Olist mudou em outra sessão/u),
  ).toBeVisible();
});

test('revoked checkbox removes the Olist route and menu after the session event', async ({
  page,
}) => {
  const mock = await setup(page);
  await page.goto('/olist');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Olist' }),
  ).toBeVisible();
  mock.revoke();
  await expect(page).toHaveURL('/dashboard');
  await expect(
    page.getByRole('link', { name: 'Olist', exact: true }),
  ).toHaveCount(0);
});

test('OAuth query is removed before the first request and callback is consumed once', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist?code=synthetic-code&state=synthetic-state');
  await expect(page).toHaveURL('/olist');
  await expect(
    page
      .getByRole('region', { name: 'Conexão da empresa' })
      .getByText('Conta Olist conectada.', { exact: true }),
  ).toBeVisible();
  expect(
    calls.every(
      (call) =>
        !call.url.includes('synthetic-code') &&
        !call.url.includes('synthetic-state'),
    ),
  ).toBe(true);
  expect(calls.filter((call) => call.path === `${base}/complete`)).toHaveLength(
    1,
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        ...globalThis.localStorage,
        ...globalThis.sessionStorage,
      }),
    ),
  ).not.toContain('synthetic-code');
  expect(
    await page.evaluate(() => JSON.stringify(globalThis.history.state)),
  ).not.toContain('synthetic-code');
  await page.reload();
  await expect(
    page.getByText('Conta conectada', { exact: true }),
  ).toBeVisible();
  expect(calls.filter((call) => call.path === `${base}/complete`)).toHaveLength(
    1,
  );
});

test('central parameters use the settings version and preserve omitted values as null', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toBeFocused();
  await page.getByLabel('Vendedor no Olist (ID)', { exact: true }).fill('23');
  await page.getByLabel('Prazo de pagamento', { exact: true }).fill('30 dias');
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(
    page
      .getByRole('region', { name: 'Conexão da empresa' })
      .getByText('Parâmetros comerciais salvos.'),
  ).toBeVisible();
  expect(
    calls.find((call) => call.path === `${base}/settings`)?.body,
  ).toMatchObject({
    expectedVersion: 4,
    settings: { ...settings, sellerId: 23, paymentTerms: '30 dias' },
  });
});

test('T11 edits every central setting without dropping fiscal, receipt or due date policy', async ({
  page,
}) => {
  const configuredSettings = {
    ...settings,
    sellerId: 23,
    receivingMethodId: 77,
    paymentDueOn: '2026-11-30',
    productFiscal: { ncm: '61091000', origin: 0, unit: 'UN' },
  };
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: { settings: configuredSettings },
  });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await expect(
    page.getByText('Versão dos parâmetros: 4.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel('Forma de recebimento (ID)')).toHaveValue('77');
  await expect(page.getByLabel('Vencimento do pagamento')).toHaveValue(
    '2026-11-30',
  );
  await expect(page.getByLabel('NCM', { exact: true })).toHaveValue('61091000');
  await page
    .getByLabel('Prazo de pagamento', { exact: true })
    .fill('Prazo explícito');
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(
    page.getByRole('heading', { name: 'Olist', exact: true }),
  ).toBeFocused();
  expect(calls.find((call) => call.path === `${base}/settings`)?.body).toEqual({
    expectedVersion: 4,
    reason: 'Parâmetros comerciais Olist atualizados pelo administrador',
    settings: {
      ...configuredSettings,
      paymentDuePolicy: 'fixed_date',
      paymentTerms: 'Prazo explícito',
    },
  });
  expect(
    calls.filter((call) => /export|previews|reconcile|links/u.test(call.path)),
  ).toHaveLength(0);
});

test('T17 admin selects per-order due dates without retaining a hidden central date', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: { settings: { ...settings, paymentDueOn: '2026-11-30' } },
  });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await page
    .getByLabel('Vencimento nos pedidos', { exact: true })
    .selectOption('per_order');
  await expect(
    page.getByLabel('Vencimento do pagamento', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(
    page.getByText('Informado em cada pedido', { exact: true }),
  ).toBeVisible();
  const saved = calls.find((call) => call.path === `${base}/settings`)?.body
    .settings;
  expect(saved.paymentDuePolicy).toBe('per_order');
  expect(saved.paymentDueOn).toBeNull();
  await expect(
    page.getByRole('heading', { name: 'Olist', exact: true }),
  ).toBeFocused();
});

test('T17 ERP-owned payment omits hidden due and payment defaults from CRM settings', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: {
      settings: {
        ...settings,
        paymentDueOn: '2026-11-30',
        paymentMethodId: 9,
        receivingMethodId: 10,
        paymentTerms: 'Prazo antigo',
      },
    },
  });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await page
    .getByLabel('Vencimento nos pedidos', { exact: true })
    .selectOption('erp');
  await expect(
    page.getByLabel('Vencimento do pagamento', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Forma de pagamento (ID)', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel('Forma de recebimento (ID)', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(
    page.getByText('Definido no Olist', { exact: true }),
  ).toBeVisible();
  const saved = calls.find((call) => call.path === `${base}/settings`)?.body
    .settings;
  expect(saved.paymentDuePolicy).toBe('erp');
  for (const key of [
    'paymentDueOn',
    'paymentMethodId',
    'receivingMethodId',
    'paymentTerms',
    'productFiscal',
  ])
    expect(saved[key]).toBeNull();
});

test('T11 rejects partial fiscal policy before any command and cancels with predictable focus', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await page.getByLabel('NCM', { exact: true }).fill('61091000');
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('alert')).toContainText(
    'origem fiscal entre 0 e 8',
  );
  expect(calls.filter((call) => call.path === `${base}/settings`)).toHaveLength(
    0,
  );
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Editar parâmetros' }),
  ).toBeFocused();
});

test('T11 stale settings preserve the draft and require a fresh explicit edit', async ({
  page,
}) => {
  const failures = { settings: { code: 'VERSION_CONFLICT', status: 409 } };
  const mock = await setup(page, {
    profile: 'admin',
    enabled: false,
    failures,
  });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await page.getByLabel('Vendedor no Olist (ID)', { exact: true }).fill('24');
  await expect(
    page.getByRole('button', { name: 'Atualizar conexão' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reconectar Olist' }),
  ).toBeDisabled();
  mock.setStatus({
    settingsVersion: 5,
    settings: { ...settings, sellerId: 99 },
  });
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toHaveValue('24');
  await expect(
    page.getByRole('button', { name: 'Salvar parâmetros' }),
  ).toBeDisabled();
  expect(
    mock.calls.find((call) => call.path === `${base}/settings`)?.body
      .expectedVersion,
  ).toBe(4);
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Editar parâmetros' }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toHaveValue('99');
});

test('T11 catalogs and exact mappings are safe keyboard reads with empty and uncertain states', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    catalogItems: [],
    mappingState: 'uncertain',
  });
  await page.goto('/olist');
  await page
    .getByText('Consultar referências no Olist', { exact: true })
    .focus();
  await page.keyboard.press('Enter');
  for (const kind of [
    'sellers',
    'warehouses',
    'paymentMethods',
    'receivingMethods',
    'priceLists',
  ]) {
    await page.getByLabel('Referência comercial').selectOption(kind);
    await page
      .getByRole('button', { name: 'Consultar referências', exact: true })
      .focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', { name: 'Referências encontradas: 0' }),
    ).toBeFocused();
    await expect(
      page.getByText('Nenhuma referência encontrada nesta categoria.'),
    ).toBeVisible();
  }
  await page
    .getByText('Consultar mapeamento registrado', { exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await page.getByLabel('Identificador do recurso no CRM').fill('501');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeFocused();
  expect(calls.filter((call) => call.path === `${base}/mappings`)).toHaveLength(
    0,
  );
  await page.getByLabel('Identificador do recurso no CRM').fill(resourceId);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Mapeamento registrado' }),
  ).toBeFocused();
  await expect(
    page.getByText('Resultado incerto', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Variação de tamanho', { exact: true }),
  ).toBeVisible();
  expect(calls.find((call) => call.path === `${base}/mappings`)?.body).toEqual({
    resourceId,
  });
  expect(
    calls
      .filter((call) => call.path === `${base}/lookups`)
      .map((call) => call.body.kind),
  ).toEqual([
    'sellers',
    'warehouses',
    'paymentMethods',
    'receivingMethods',
    'priceLists',
  ]);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const failure of [
  {
    code: 'OLIST_RESOURCE_NOT_FOUND',
    status: 404,
    text: 'Mapeamento não encontrado',
  },
  {
    code: 'OLIST_RATE_LIMITED',
    status: 429,
    text: 'Limite de consultas atingido',
  },
  {
    code: 'OLIST_RECONNECT_REQUIRED',
    status: 409,
    text: 'Reconecte a conta Olist',
  },
  { code: 'FORBIDDEN', status: 403, text: 'Seu acesso mudou' },
]) {
  test(`T11 mapping ${failure.code} gives safe feedback and focus`, async ({
    page,
  }) => {
    await setup(page, {
      profile: 'admin',
      enabled: false,
      failures: { mappings: failure },
    });
    await page.goto('/olist');
    await page
      .getByText('Consultar mapeamento registrado', { exact: true })
      .click();
    await page.getByLabel('Identificador do recurso no CRM').fill(resourceId);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toBeFocused();
    await expect(page.getByRole('alert')).toContainText(failure.text);
    await expect(page.locator('body')).not.toContainText(
      'private-provider-detail-canary',
    );
  });
}

test('T11 disconnected account blocks remote reads while preserving local mapping inspection', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: { connected: false, reconnectRequired: true },
  });
  await page.goto('/olist');
  await expect(
    page.getByText('Reconexão necessária', { exact: true }),
  ).toBeVisible();
  await page
    .getByText('Consultar referências no Olist', { exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Consultar referências', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reconectar Olist' }),
  ).toBeEnabled();
  await page
    .getByText('Consultar mapeamento registrado', { exact: true })
    .click();
  await page.getByLabel('Identificador do recurso no CRM').fill(resourceId);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Mapeamento registrado' }),
  ).toBeVisible();
  expect(calls.filter((call) => call.path === `${base}/lookups`)).toHaveLength(
    0,
  );
});

test('T11 disconnect clears administrative results and posts the connection version', async ({
  page,
}) => {
  const { calls } = await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await page
    .getByText('Consultar referências no Olist', { exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Consultar referências', exact: true })
    .click();
  await expect(
    page.getByText('Referência sintética', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Desconectar Olist', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Olist', exact: true }),
  ).toBeFocused();
  await expect(
    page.getByText('Referência sintética', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Conta desconectada', { exact: true }),
  ).toBeVisible();
  expect(
    calls.find((call) => call.path === `${base}/disconnect`)?.body
      .expectedVersion,
  ).toBe(3);
});

for (const query of [
  'code=synthetic-code&state=synthetic-state&state=duplicate',
  'error=access_denied&state=synthetic-state',
  'code=synthetic-code',
]) {
  test(`T11 invalid callback is cleaned without completion: ${query}`, async ({
    page,
  }) => {
    const { calls } = await setup(page, { profile: 'admin', enabled: false });
    await page.goto(`/olist?${query}`);
    await expect(page).toHaveURL('/olist');
    await expect(page.getByRole('alert')).toBeFocused();
    expect(
      calls.filter((call) => call.path === `${base}/complete`),
    ).toHaveLength(0);
    expect(calls.every((call) => !call.url.includes('synthetic-'))).toBe(true);
  });
}

test('T11 admin mobile and dark reflow keep parameters and mappings accessible and names inert', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const name = '<img src=x onerror=alert(1)> synthetic catalog';
  await setup(page, {
    profile: 'admin',
    enabled: false,
    catalogItems: [{ id: 23, name }],
  });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await page
    .getByText('Consultar referências no Olist', { exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Consultar referências', exact: true })
    .click();
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator('.olist-reference-list img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Gerar/u })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('heading', { name: 'Olist', exact: true }).focus();
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({ path: 'var/olist-admin-mobile.png', fullPage: true });
  await page.evaluate(() => {
    globalThis.document.documentElement.dataset.theme = 'dark';
  });
  await page.setViewportSize({ width: 320, height: 844 });
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({
    path: 'var/olist-admin-dark-320.png',
    fullPage: true,
  });
});

test('T11 late catalog response cannot restore data after administrative capability revocation', async ({
  page,
}) => {
  const mock = await setup(page, { profile: 'admin', enabled: true });
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(null);
  });
  await page.route(`**${base}/lookups`, async (route) => {
    await gate;
    await route.fulfill({
      json: { items: [{ id: 23, name: 'Late private catalog' }] },
    });
  });
  await page.goto('/olist');
  await page
    .getByText('Consultar referências no Olist', { exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Consultar referências', exact: true })
    .click();
  await expect(
    page.getByText('Consultando as referências da conta…'),
  ).toBeVisible();
  mock.revokeManagement();
  await expect(
    page.getByRole('heading', { name: 'Conexão da empresa' }),
  ).toHaveCount(0);
  release();
  await expect(
    page.getByRole('heading', { name: 'Mapeamentos e referências' }),
  ).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Late private catalog');
});

test('T11 refresh cannot open an edit against stale settings and desktop layout remains accessible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await setup(page, { profile: 'admin', enabled: false });
  await page.goto('/olist');
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(null);
  });
  await page.route(`**${base}/status`, async (route) => {
    await gate;
    await route.fulfill({
      json: {
        ...connected,
        settingsVersion: 5,
        settings: { ...settings, sellerId: 88 },
      },
    });
  });
  await page.getByRole('button', { name: 'Atualizar conexão' }).click();
  await expect(page.getByText('Consultando a conexão…')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Editar parâmetros' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Reconectar Olist' }),
  ).toBeDisabled();
  release();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toHaveValue('88');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('heading', { name: 'Olist', exact: true }).focus();
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({
    path: 'var/olist-admin-desktop.png',
    fullPage: true,
  });
  // A 1366px viewport at 200% zoom has 683 CSS pixels of usable width.
  await page.setViewportSize({ width: 683, height: 384 });
  expect(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  ).toBe(true);
  await expect(
    page.getByLabel('Vendedor no Olist (ID)', { exact: true }),
  ).toHaveValue('88');
});

test('T11 connection error remains safe and focused with a retry action', async ({
  page,
}) => {
  await setup(page, {
    profile: 'admin',
    enabled: false,
    failures: { status: { status: 503, code: 'SERVICE_UNAVAILABLE' } },
  });
  await page.goto('/olist');
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(
    page.getByRole('button', { name: 'Atualizar conexão' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Editar parâmetros' }),
  ).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(
    'private-provider-detail-canary',
  );
});

test('T11 reconnect uses the official OAuth destination by keyboard without completing or creating entities', async ({
  page,
}) => {
  const authorizationUrl =
    'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth?state=synthetic-once';
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    authorizationUrl,
    initialStatus: { connected: false, reconnectRequired: true },
  });
  await page.route('https://accounts.tiny.com.br/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Autorização sintética</title>',
    }),
  );
  await page.goto('/olist');
  await page.getByRole('button', { name: 'Reconectar Olist' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(authorizationUrl);
  expect(
    calls.filter((call) => call.path === `${base}/authorize`),
  ).toHaveLength(1);
  expect(
    calls.filter((call) => /complete|export|links|reconcile/u.test(call.path)),
  ).toHaveLength(0);
});

test('T11 incomplete deployment configuration offers no unusable editor or remote commands', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: {
      configured: false,
      accountConfigured: false,
      connected: false,
    },
  });
  await page.goto('/olist');
  await expect(
    page.getByText('Conexão ainda não configurada', { exact: true }),
  ).toBeVisible();
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Editar parâmetros' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Conectar Olist', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Mapeamentos e referências' }),
  ).toHaveCount(0);
  expect(
    calls.filter((call) =>
      [
        base + '/settings',
        base + '/lookups',
        base + '/mappings',
        base + '/authorize',
      ].includes(call.path),
    ),
  ).toHaveLength(0);
});

test('T11 unsafe identifiers are rejected locally and expiration uses São Paulo time', async ({
  page,
}) => {
  const { calls } = await setup(page, {
    profile: 'admin',
    enabled: false,
    initialStatus: { expiresAt: '2026-11-30T15:00:00.000Z' },
  });
  await page.goto('/olist');
  await expect(
    page.getByText(/Acesso válido até 30.11.2026, 12:00/u),
  ).toBeVisible();
  await page.getByText('Parâmetros comerciais', { exact: true }).click();
  await page.getByRole('button', { name: 'Editar parâmetros' }).click();
  await page
    .getByLabel('Vendedor no Olist (ID)', { exact: true })
    .fill('9007199254740992');
  await page.getByRole('button', { name: 'Salvar parâmetros' }).click();
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(page.getByRole('alert')).toContainText(
    'números inteiros positivos',
  );
  expect(calls.filter((call) => call.path === `${base}/settings`)).toHaveLength(
    0,
  );
});
