import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const ADMIN = {
  capabilities: ['COMMERCIAL_ADMIN'],
  canDelete: false,
  createdAt: '2026-03-12T12:00:00.000Z',
  disabledAt: null,
  email: 'romulo@silmer.com.br',
  functionName: 'Vendedor',
  id: 'admin-1',
  name: 'Rômulo Sutil',
};
const SELLER = {
  capabilities: [],
  canDelete: true,
  createdAt: '2026-06-02T12:00:00.000Z',
  disabledAt: null,
  email: 'marina.duarte@silmer.com.br',
  functionName: 'Vendedor',
  id: 'seller-1',
  name: 'Marina Duarte',
};

/**
 * @param {import('@playwright/test').Page} page
 * @param {{capabilities?: string[], externalChangeOnEvent?: boolean, revokeSelfOnEvent?: boolean}} [options]
 */
async function mockUsers(page, options = {}) {
  const viewer = {
    ...ADMIN,
    capabilities: [...(options.capabilities ?? ADMIN.capabilities)],
  };
  /** @type {Array<Record<string, any>>} */
  const users = [
    { ...ADMIN, capabilities: [...ADMIN.capabilities] },
    { ...SELLER, capabilities: [...SELLER.capabilities] },
  ];
  /** @type {Array<{method: string, path: string, body: any}>} */
  const commands = [];
  let sessionReads = 0;
  let listReads = 0;
  /** @type {() => void} */
  let releaseEvent = () => {};
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const json = (/** @type {unknown} */ body, status = 200) =>
      route.fulfill({
        body: JSON.stringify(body),
        contentType: 'application/json',
        status,
      });

    if (path === '/api/v1/sessions/current' && method === 'GET') {
      sessionReads += 1;
      return json({ user: viewer });
    }
    if (path === '/api/v1/events') {
      if (!options.revokeSelfOnEvent && !options.externalChangeOnEvent)
        return route.fulfill({ status: 204 });
      await eventGate;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: `retry: 60000\n\nevent: identity.user.changed\nid: evt-2\ndata: {"userId":"${options.externalChangeOnEvent ? 'seller-1' : 'admin-1'}"}\n\n`,
      });
    }
    if (path === '/api/v1/kanban') {
      return json({ columns: [], eventCursor: 'evt-1' });
    }
    if (path === '/api/v1/users' && method === 'GET') {
      listReads += 1;
      return json({ users });
    }
    if (path === '/api/v1/users' && method === 'POST') {
      const body = request.postDataJSON();
      commands.push({ body, method, path });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      const created = {
        capabilities: body.accessType === 'admin' ? ['COMMERCIAL_ADMIN'] : [],
        canDelete: body.accessType !== 'admin',
        createdAt: '2026-09-09T12:00:00.000Z',
        disabledAt: null,
        email: body.email,
        functionName: body.accessType === 'finance' ? 'Financeiro' : 'Vendedor',
        id: 'seller-2',
        name: body.name,
      };
      users.push(created);
      return json({ user: created }, 201);
    }
    if (path.startsWith('/api/v1/users/') && method === 'PATCH') {
      const body = request.postDataJSON();
      commands.push({ body, method, path });
      expect(request.headers()['idempotency-key']).toBeTruthy();
      const target = users.find((user) => path.endsWith(user.id));
      if (target && body.name) target.name = body.name;
      if (target && body.accessType) {
        target.functionName =
          body.accessType === 'finance' ? 'Financeiro' : 'Vendedor';
        target.capabilities =
          body.accessType === 'admin' ? ['COMMERCIAL_ADMIN'] : [];
      }
      return json({ user: target });
    }
    if (path.startsWith('/api/v1/users/') && method === 'DELETE') {
      const body = request.postDataJSON();
      commands.push({ body, method, path });
      const index = users.findIndex((user) => path.endsWith(user.id));
      if (index >= 0) users.splice(index, 1);
      return json({ deleted: true });
    }
    if (path.endsWith('/disable') && method === 'POST') {
      const body = request.postDataJSON();
      commands.push({ body, method, path });
      const target = users.find((user) => path.includes(user.id));
      if (target) target.disabledAt = '2026-09-09T13:00:00.000Z';
      return json({ user: target });
    }
    if (path.endsWith('/enable') && method === 'POST') {
      const body = request.postDataJSON();
      commands.push({ body, method, path });
      const target = users.find((user) => path.includes(user.id));
      if (target) target.disabledAt = null;
      return json({ user: target });
    }
    return route.fulfill({ body: '{}', status: 404 });
  });

  return {
    commands,
    users,
    listReads: () => listReads,
    sessionReads: () => sessionReads,
    renameSellerElsewhere() {
      users[1].name = 'Marina Atualizada';
      releaseEvent();
    },
    revokeSelf() {
      viewer.capabilities = [];
      releaseEvent();
    },
  };
}

/** @param {import('@playwright/test').Page} page @param {string} name */
async function openActions(page, name) {
  await page.getByLabel(`Mais ações para ${name}`).click();
}

for (const profile of [
  { value: 'seller', label: 'Vendedor' },
  { value: 'finance', label: 'Financeiro' },
  { value: 'admin', label: 'Administrador' },
]) {
  test(`creates a user with the ${profile.label} access profile`, async ({
    page,
  }) => {
    const mock = await mockUsers(page);
    await page.goto('/usuarios');
    await page.getByLabel('Nome', { exact: true }).fill('Conta de exemplo');
    await page.getByLabel('E-mail', { exact: true }).fill('conta@example.test');
    await page
      .getByLabel('Perfil de acesso', { exact: true })
      .selectOption(profile.value);
    await page.getByLabel('Senha', { exact: true }).fill('senha-de-teste');
    await page
      .getByRole('button', { name: 'Criar usuário', exact: true })
      .click();
    await expect(
      page.getByRole('row', { name: /Conta de exemplo/u }),
    ).toContainText(profile.label);
    expect(mock.commands[0].body.accessType).toBe(profile.value);
  });
}

test('edits another access profile while keeping the current administrator profile protected', async ({
  page,
}) => {
  const mock = await mockUsers(page);
  await page.goto('/usuarios');
  await openActions(page, 'Marina Duarte');
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Perfil de acesso', { exact: true })
    .selectOption('finance');
  await dialog
    .getByRole('button', { name: 'Salvar alterações', exact: true })
    .click();
  await expect(page.getByRole('row', { name: /Marina Duarte/u })).toContainText(
    'Financeiro',
  );
  expect(mock.commands[0].body).toMatchObject({ accessType: 'finance' });
  expect(mock.commands[0].body.name).toBeUndefined();
  await openActions(page, ADMIN.name);
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  await expect(
    dialog.getByLabel('Perfil de acesso', { exact: true }),
  ).toBeDisabled();
  await expect(dialog.getByLabel('Nome', { exact: true })).toBeEnabled();
});

test('lists accounts and hands over the created credentials as markdown', async ({
  page,
}) => {
  const { commands } = await mockUsers(page);
  await page.goto('/usuarios');

  await expect(
    page.getByRole('heading', { exact: true, name: 'Usuários' }),
  ).toBeFocused();
  await expect(
    page
      .getByLabel('Usuários do CRM')
      .getByText('Administrador', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(
    page.getByText('2 contas · 2 ativas · 0 desativadas'),
  ).toBeVisible();

  await page.getByLabel('Nome').fill('Helena Nogueira');
  await page.getByLabel('E-mail').fill('helena.nogueira@silmer.com.br');
  await page.getByLabel('Senha', { exact: true }).fill('x');
  await page.getByRole('button', { name: 'Criar usuário' }).click();

  const block = page.locator('.markdown-block');
  await expect(block).toContainText('- Nome: Helena Nogueira');
  await expect(block).toContainText('- E-mail: helena.nogueira@silmer.com.br');
  await expect(block).toContainText('- Senha: x');
  await expect(page.getByRole('button', { name: 'Copiar' })).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(4);

  // The password travels in the request but never comes back in a response.
  expect(commands).toHaveLength(1);
  expect(commands[0].body).toMatchObject({
    email: 'helena.nogueira@silmer.com.br',
    name: 'Helena Nogueira',
    password: 'x',
  });

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

for (const interaction of ['edit', 'menu', 'delete']) {
  test(`reconciles a live user change after closing the ${interaction} interaction`, async ({
    page,
  }) => {
    const mock = await mockUsers(page, { externalChangeOnEvent: true });
    await page.goto('/usuarios');
    await expect(
      page.getByRole('row', { name: /Marina Duarte/u }),
    ).toBeVisible();
    expect(mock.listReads()).toBe(1);

    await openActions(page, 'Marina Duarte');
    if (interaction === 'edit') {
      await page.getByRole('button', { name: 'Editar' }).click();
      const nameInput = page.getByRole('dialog').getByLabel('Nome');
      await nameInput.fill('Marina Rascunho');
      await nameInput.focus();
    } else if (interaction === 'delete') {
      await page.getByRole('button', { name: 'Excluir' }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
    }

    mock.renameSellerElsewhere();
    await expect(page.locator('.sr-only[role="status"]')).toHaveText(
      'Conteúdo atualizado automaticamente.',
    );
    await expect(
      page.getByRole('row', { name: /Marina Duarte/u }),
    ).toBeVisible();
    expect(mock.listReads()).toBe(1);
    if (interaction === 'edit') {
      const nameInput = page.getByRole('dialog').getByLabel('Nome');
      await expect(nameInput).toHaveValue('Marina Rascunho');
      await expect(nameInput).toBeFocused();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancelar' })
        .click();
    } else if (interaction === 'delete') {
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Cancelar' })
        .click();
    } else {
      await page.getByLabel('Mais ações para Marina Duarte').press('Escape');
    }

    await expect.poll(mock.listReads).toBeGreaterThan(1);
    await expect(
      page.getByRole('row', { name: /Marina Atualizada/u }),
    ).toBeVisible();
  });
}

test('edits one field at a time and disables an account', async ({ page }) => {
  const { commands } = await mockUsers(page);
  await page.goto('/usuarios');

  await page
    .getByRole('row', { name: /Marina Duarte/u })
    .getByLabel('Mais ações para Marina Duarte')
    .click();
  await page.getByRole('button', { name: 'Editar' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Nome').fill('Marina Duarte Lima');
  await dialog.getByRole('button', { name: 'Salvar alterações' }).click();

  await expect(dialog).toBeHidden();
  expect(commands).toHaveLength(1);
  // Only the changed field is sent; e-mail and password stay untouched.
  expect(commands[0].body.name).toBe('Marina Duarte Lima');
  expect(commands[0].body.email).toBeUndefined();
  expect(commands[0].body.password).toBeUndefined();

  const trigger = page
    .getByRole('row', { name: /Marina Duarte Lima/u })
    .getByLabel('Mais ações para Marina Duarte Lima');
  await trigger.click();
  await page.getByRole('button', { name: 'Desativar' }).click();
  // Pesquisa UX 2026-10-15, achado 6: asked first, never on the first click.
  const confirm = page.getByRole('alertdialog', {
    name: 'Desativar Marina Duarte Lima?',
  });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('perde o acesso ao CRM');
  await expect(confirm.getByRole('button', { name: 'Cancelar' })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await confirm.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(commands).toHaveLength(1);

  await trigger.click();
  await page.getByRole('button', { name: 'Desativar' }).click();
  await confirm.getByRole('button', { name: 'Desativar conta' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(
    page.getByText('2 contas · 1 ativas · 1 desativadas'),
  ).toBeVisible();
  expect(commands.at(-1)?.path).toMatch(/\/disable$/u);
  await expect(trigger).toBeFocused();

  // The result is seen, not only announced, and can be undone from there.
  const toast = page.locator('.notice-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Conta de Marina Duarte Lima desativada.');
  await toast.getByRole('button', { name: 'Desfazer' }).click();
  await expect(
    page.getByText('2 contas · 2 ativas · 0 desativadas'),
  ).toBeVisible();
  expect(commands.at(-1)?.path).toMatch(/\/enable$/u);
  await expect(toast).toContainText('Conta de Marina Duarte Lima reativada.');
});

test('asks before disabling from the edit dialog, without a dialog over it', async ({
  page,
}) => {
  const { commands } = await mockUsers(page);
  await page.goto('/usuarios');

  await page.getByLabel('Mais ações para Marina Duarte').click();
  await page.getByRole('button', { name: 'Editar' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Desativar conta' })
    .click();

  const confirm = page.getByRole('alertdialog', {
    name: 'Desativar Marina Duarte?',
  });
  await expect(confirm).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(commands).toHaveLength(0);
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByLabel('Mais ações para Marina Duarte')).toBeFocused();
  expect(commands).toHaveLength(0);
});

test('offers permanent deletion only for a seller without history', async ({
  page,
}) => {
  const { commands } = await mockUsers(page);
  await page.goto('/usuarios');

  await openActions(page, 'Rômulo Sutil');
  await expect(page.getByRole('button', { name: 'Excluir' })).toHaveCount(0);
  await openActions(page, 'Rômulo Sutil');

  const sellerRow = page.getByRole('row', { name: /Marina Duarte/u });
  const sellerRowBefore = await sellerRow.boundingBox();
  if (!sellerRowBefore) throw new Error('Linha de Marina não encontrada.');
  await openActions(page, 'Marina Duarte');
  await expect(page.locator('.row-menu-popover')).toBeVisible();
  const sellerRowAfter = await sellerRow.boundingBox();
  if (!sellerRowAfter) throw new Error('Linha de Marina não encontrada.');
  expect(sellerRowAfter.height).toBe(sellerRowBefore.height);
  await page.getByLabel('Mais ações para Marina Duarte').click();

  await openActions(page, 'Marina Duarte');
  await page.getByRole('button', { name: 'Excluir' }).click();
  const confirmation = page.getByRole('alertdialog');
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText('Excluir Marina Duarte?');
  await confirmation.getByRole('button', { name: 'Cancelar' }).click();
  expect(commands).toHaveLength(0);

  await openActions(page, 'Marina Duarte');
  await page.getByRole('button', { name: 'Excluir' }).click();
  await confirmation.getByRole('button', { name: 'Excluir conta' }).click();

  await expect(page.getByRole('row')).toHaveCount(2);
  expect(commands.at(-1)).toMatchObject({
    body: { reason: expect.any(String) },
    method: 'DELETE',
    path: '/api/v1/users/seller-1',
  });
});

test('redirects a non-admin away from the users screen and hides its navigation entry', async ({
  page,
}) => {
  await mockUsers(page, { capabilities: [] });
  await page.goto('/usuarios');

  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(page.getByRole('link', { name: 'Usuários' })).toHaveCount(0);
  await expect(page.getByText('Vendedor')).toBeVisible();
  await expect(
    page.getByRole('heading', { exact: true, name: 'Dashboard' }),
  ).toBeVisible();
});

test('removes own admin navigation and route after a named SSE role change', async ({
  page,
}) => {
  const mock = await mockUsers(page, { revokeSelfOnEvent: true });
  await page.goto('/usuarios');
  await expect(
    page.getByRole('heading', { exact: true, name: 'Usuários' }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'Usuários' })).toBeVisible();
  expect(mock.sessionReads()).toBe(1);

  mock.revokeSelf();

  await expect.poll(mock.sessionReads).toBeGreaterThan(1);
  await expect(page).toHaveURL(/\/dashboard$/u);
  await expect(page.getByRole('link', { name: 'Usuários' })).toHaveCount(0);
  await expect(
    page.getByRole('heading', { exact: true, name: 'Dashboard' }),
  ).toBeVisible();
});
