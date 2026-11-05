import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { actionItems, mockPainel } from './support/painel-mock.js';

test('one order has independent payment and delivery confirmations, with a frozen version', async ({
  page,
}) => {
  const mock = await mockPainel(page, { manager: false });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Registrar pagamento', exact: true })
    .click();
  await actions.getByLabel('Data do recebimento integral').fill('2026-10-14');
  await actions
    .getByRole('button', { name: 'Confirmar pagamento', exact: true })
    .click();
  expect(mock.writes).toHaveLength(0);
  await actions
    .getByRole('checkbox', {
      name: 'Confirmo que o valor integral foi recebido.',
    })
    .check();
  await actions
    .getByRole('button', { name: 'Confirmar pagamento', exact: true })
    .focus();
  await page.keyboard.press('Enter');
  await expect(
    actions.getByText('Pagamento integral registrado em 14/10/2026.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    actions.getByRole('button', { name: 'Registrar entrega', exact: true }),
  ).toBeVisible();
  await expect(
    actions.getByRole('button', { name: 'Tudo 5', exact: true }),
  ).toBeVisible();
  expect(mock.writes[0]).toMatchObject({
    path: '/api/v1/orders/manual-12/payment-confirmation',
    method: 'POST',
    body: { expectedVersion: 4, paidOn: '2026-10-14', receivedInFull: true },
  });
  expect(mock.writes[0].key).toBeTruthy();
  await actions
    .getByRole('button', { name: 'Registrar entrega', exact: true })
    .click();
  await expect(actions).toContainText(
    'A entrega será registrada em 15/10/2026',
  );
  await actions
    .getByRole('button', { name: 'Confirmar entrega de hoje', exact: true })
    .click();
  await expect(
    actions.getByRole('button', {
      name: 'Abrir Equipe Sintética',
      exact: true,
    }),
  ).toHaveCount(0);
  expect(mock.writes[1].body).toEqual({ expectedVersion: 5 });
  expect(mock.writes[1].path).toBe(
    '/api/v1/orders/manual-12/delivery-confirmation',
  );
  expect(mock.writes[1].key).not.toBe(mock.writes[0].key);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

test('a deferred order stays an obligation, resume uses the decision version, and no external message is sent', async ({
  page,
}) => {
  const mock = await mockPainel(page, { manager: false });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Lembrar depois', exact: true })
    .click();
  await actions
    .getByLabel('Data e horário de São Paulo')
    .fill('2026-10-16T09:00');
  await actions
    .getByRole('button', { name: 'Salvar lembrete', exact: true })
    .click();
  await expect(
    actions.getByRole('button', { name: 'Tudo 4', exact: true }),
  ).toBeVisible();
  await actions.getByRole('button', { name: 'Adiados 1', exact: true }).click();
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .click();
  await expect(actions).toContainText(
    'Ainda sem quitação integral registrada.',
  );
  await actions
    .getByRole('button', { name: 'Trazer para agora', exact: true })
    .click();
  expect(mock.writes[0].body).toEqual({
    decision: 'snooze',
    expectedVersion: 4,
    sourceRevision: 'revision-4',
    expectedDecisionVersion: 0,
    remindAt: '2026-10-16T12:00:00.000Z',
  });
  expect(mock.writes[1].body).toEqual({
    decision: 'resume',
    expectedVersion: 4,
    sourceRevision: 'revision-4',
    expectedDecisionVersion: 1,
  });
  expect(mock.writes.every((write) => write.path.endsWith('/decision'))).toBe(
    true,
  );
});

test('a version conflict keeps the date and explicit confirmation until the person requests new data', async ({
  page,
}) => {
  const mock = await mockPainel(page, { manager: false });
  await page.route('**/api/v1/orders/*/payment-confirmation', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'VERSION_CONFLICT' }),
    }),
  );
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Registrar pagamento', exact: true })
    .click();
  await actions.getByLabel('Data do recebimento integral').fill('2026-10-14');
  const check = actions.getByRole('checkbox', {
    name: 'Confirmo que o valor integral foi recebido.',
  });
  await check.check();
  await actions
    .getByRole('button', { name: 'Confirmar pagamento', exact: true })
    .click();
  await expect(actions.getByRole('alert')).toContainText(
    'A providência mudou.',
  );
  await expect(actions.getByLabel('Data do recebimento integral')).toHaveValue(
    '2026-10-14',
  );
  await expect(check).toBeChecked();
  await expect(
    actions.getByRole('button', { name: 'Confirmar pagamento', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  await actions.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .click();
  await expect(
    actions.getByRole('button', { name: 'Registrar pagamento', exact: true }),
  ).toHaveAttribute('aria-disabled', 'true');
  const rows = actionItems();
  rows[1].order.finalAmountCents = 200000;
  rows[1].targetVersion = 5;
  mock.setActions(rows);
  await actions
    .getByRole('button', { name: 'Atualizar antes de tentar', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Abrir Equipe Sintética', exact: true })
    .click();
  await actions
    .getByRole('button', { name: 'Registrar pagamento', exact: true })
    .click();
  await expect(actions).toContainText('R$ 2.000,00');
  await expect(actions.getByLabel('Data do recebimento integral')).toHaveValue(
    '2026-10-14',
  );
  await expect(check).not.toBeChecked();
});

test('permission rejection stays visible and cannot be bypassed by selecting the order again', async ({
  page,
}) => {
  await mockPainel(page, { manager: false });
  let writes = 0;
  await page.route('**/api/v1/orders/*/payment-confirmation', (route) => {
    writes += 1;
    return route.fulfill({
      status: 403,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'FORBIDDEN' }),
    });
  });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  const row = actions.getByRole('button', {
    name: 'Abrir Equipe Sintética',
    exact: true,
  });
  await row.click();
  await actions
    .getByRole('button', { name: 'Registrar pagamento', exact: true })
    .click();
  await actions
    .getByLabel('Confirmo que o valor integral foi recebido.')
    .check();
  await actions
    .getByRole('button', { name: 'Confirmar pagamento', exact: true })
    .click();
  await expect(actions.getByRole('alert')).toContainText(
    'Você não pode mais alterar esta providência.',
  );
  await actions.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await row.click();
  const register = actions.getByRole('button', {
    name: 'Registrar pagamento',
    exact: true,
  });
  await expect(register).toHaveAttribute('aria-disabled', 'true');
  await register.focus();
  await page.keyboard.press('Enter');
  await expect(actions.getByLabel('Data do recebimento integral')).toHaveCount(
    0,
  );
  expect(writes).toBe(1);
  await expect(
    actions.getByRole('button', {
      name: 'Atualizar antes de tentar',
      exact: true,
    }),
  ).toBeVisible();
});

test('suggestions can be dismissed without closing a conversation, while a handoff must be assumed in the Inbox', async ({
  page,
}) => {
  const mock = await mockPainel(page, { manager: false });
  await page.goto('/dashboard');
  const actions = page.getByRole('region', { name: 'O que precisa de você' });
  await actions
    .getByRole('button', { name: 'Abrir Contato Sintético', exact: true })
    .click();
  await expect(
    actions.getByRole('link', { name: 'Abrir conversa para retomar' }),
  ).toHaveAttribute('href', '/inbox/follow-1');
  await actions
    .getByRole('button', { name: 'Dispensar sugestão', exact: true })
    .click();
  expect(mock.writes[0].body.decision).toBe('dismiss');
  await expect(actions.getByRole('status')).toContainText(
    'A conversa continua aberta.',
  );
  await actions
    .getByRole('button', { name: 'Abrir Conversa Sintética', exact: true })
    .click();
  await expect(
    actions.getByRole('link', { name: 'Abrir conversa para assumir' }),
  ).toHaveAttribute('href', '/inbox/waiting-1');
  await expect(
    actions.getByRole('button', { name: 'Lembrar depois' }),
  ).toHaveCount(0);
});
