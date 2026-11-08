import { expect, test } from '@playwright/test';
import { withBucket } from './support/inbox-bucket.js';

/** @param {import('@playwright/test').Page} page */
async function mockConcurrentContact(page) {
  let currentName = 'Studio Malu';
  let currentVersion = 2;
  let detailReads = 0;
  /** @type {any[]} */
  const writes = [];
  /** @type {() => void} */
  let releaseEvent = () => {};
  /** @type {() => void} */
  let signalStream = () => {};
  const eventGate = new Promise((resolve) => {
    releaseEvent = () => resolve(null);
  });
  const streamReady = new Promise((resolve) => {
    signalStream = () => resolve(null);
  });
  const contact = () => ({
    createdAt: '2026-09-01T12:00:00.000Z',
    displayName: currentName,
    id: 'contact-1',
    identities: [
      {
        id: 'identity-1',
        channel: 'whatsapp',
        kind: 'phone',
        externalId: '5511999999999',
      },
    ],
    label: currentName,
    latestActivityAt: '2026-09-08T12:00:00.000Z',
    provisional: false,
    version: currentVersion,
  });
  const conversation = () => ({
    assignedUser: { id: 'seller-1', name: 'Marina' },
    automationState: 'human',
    channel: 'whatsapp',
    contact: {
      id: 'contact-1',
      label: currentName,
      displayName: currentName,
      externalId: '5511999999999',
      version: currentVersion,
    },
    handoff: null,
    id: 'conversation-1',
    lastMessage: {
      direction: 'inbound',
      preview: 'Bom dia',
      type: 'text',
      occurredAt: '2026-09-08T12:00:00.000Z',
    },
    requiresAttention: false,
    state: 'em_atendimento',
    updatedAt: '2026-09-08T12:00:00.000Z',
    version: 3,
  });

  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/v1/sessions/current') {
      return route.fulfill({
        json: { user: { id: 'seller-1', name: 'Marina', capabilities: [] } },
      });
    }
    if (path === '/api/v1/events') {
      signalStream();
      await eventGate;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\nevent: inbox.contact.changed\nid: evt-2\ndata: {"contactId":"contact-1"}\n\n',
      });
    }
    if (path === '/api/v1/contacts') {
      return route.fulfill({ json: { items: [contact()], totalCount: 1 } });
    }
    if (
      path === '/api/v1/contacts/contact-1' &&
      route.request().method() === 'GET'
    ) {
      detailReads += 1;
      return route.fulfill({
        json: {
          contact: contact(),
          identities: contact().identities,
          conversations: [],
          deals: [],
        },
      });
    }
    if (
      path === '/api/v1/contacts/contact-1/name' &&
      route.request().method() === 'POST'
    ) {
      const body = route.request().postDataJSON();
      writes.push(body);
      if (body.expectedVersion !== currentVersion) {
        return route.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          json: { error: { code: 'CONTACT_CONFLICT' } },
        });
      }
      currentName = body.displayName;
      currentVersion += 1;
      return route.fulfill({ json: { contact: contact() } });
    }
    if (path === '/api/v1/inbox/conversations') {
      return route.fulfill({
        json: {
          items: withBucket([conversation()], route.request().url()),
          totalCount: 1,
          nextCursor: null,
        },
      });
    }
    if (path === '/api/v1/inbox/conversations/conversation-1') {
      detailReads += 1;
      return route.fulfill({
        json: { conversation: conversation(), messages: [] },
      });
    }
    if (path === '/api/v1/users/assignable') {
      return route.fulfill({ json: { users: [] } });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  return {
    writes,
    detailReads: () => detailReads,
    currentName: () => currentName,
    waitForStream: () => streamReady,
    remoteRename() {
      currentName = 'Nome de outro vendedor';
      currentVersion = 3;
      releaseEvent();
    },
  };
}

/**
 * INBOX-UX-03: the Inbox opens the contact drawer through the person's name;
 * the Clientes flow keeps its existing inline summary.
 *
 * @param {import('@playwright/test').Page} page @param {string} route
 */
async function openClientDetails(page, route) {
  if (route !== '/inbox') return;
  await page
    .getByRole('button', { name: 'Dados de Studio Malu', exact: true })
    .click();
}

/** @param {import('@playwright/test').Page} page @param {string} route @param {string} name */
async function expectCurrentName(page, route, name) {
  if (route === '/inbox') {
    // A modal makes the background title inert: inspect the actual visible
    // contact data rather than relying on a heading behind the drawer.
    const displayedName = page
      .getByRole('dialog', { name: 'Cadastro', exact: true })
      .locator('dd')
      .filter({ hasText: name });
    await expect(displayedName).toBeVisible();
    await expect(displayedName).toHaveText(name);
  } else {
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
  }
}

for (const route of ['/clientes', '/inbox']) {
  test(`${route} still saves a name from the version opened for editing`, async ({
    page,
  }) => {
    const mock = await mockConcurrentContact(page);
    await page.goto(route);
    await openClientDetails(page, route);
    await page.getByRole('button', { name: 'Editar nome' }).click();
    await page
      .getByRole('textbox', { name: 'Nome do contato' })
      .fill('Nome conferido');
    await page.getByRole('button', { name: 'Salvar nome' }).click();
    await expectCurrentName(page, route, 'Nome conferido');
    await expect(
      page.getByRole('button', { name: 'Editar nome' }),
    ).toBeFocused();
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0].expectedVersion).toBe(2);
    expect(mock.currentName()).toBe('Nome conferido');
  });

  test(`${route} keeps the opened name version and draft after concurrent rename`, async ({
    page,
  }) => {
    const mock = await mockConcurrentContact(page);
    await page.goto(route);
    await openClientDetails(page, route);
    await page.getByRole('button', { name: 'Editar nome' }).click();
    const input = page.getByRole('textbox', { name: 'Nome do contato' });
    await input.fill('Meu rascunho');
    await mock.waitForStream();
    const readsBeforeEvent = mock.detailReads();
    mock.remoteRename();
    await expect.poll(mock.detailReads).toBeGreaterThan(readsBeforeEvent);

    await page.getByRole('button', { name: 'Salvar nome' }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'O nome mudou enquanto você editava' }),
    ).toContainText('Nome de outro vendedor');
    await expect(input).toHaveValue('Meu rascunho');
    await expect(input).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Salvar nome' }),
    ).toBeDisabled();
    expect(mock.writes).toHaveLength(1);
    expect(mock.writes[0].expectedVersion).toBe(2);
    expect(mock.currentName()).toBe('Nome de outro vendedor');

    await page.getByRole('button', { name: 'Cancelar' }).click();
    await expect(
      page.getByRole('button', { name: 'Editar nome' }),
    ).toBeFocused();
    await expectCurrentName(page, route, 'Nome de outro vendedor');
  });
}
