import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

import { isRegistrationComplete } from '../../apps/edge-web/src/lib/contact-registration.js';

// CP-25..28 / CP-T08. Synthetic data only: check-digit vectors published for
// testing (CPF 529.982.247-25, the Receita Federal alphanumeric CNPJ example)
// and example.com e-mails.

/** @param {import('@playwright/test').Page} page */
async function mockRegistrationApi(page) {
  /** @type {Record<string, any>} */
  const contacts = {
    'contact-1': {
      createdAt: '2026-09-01T12:00:00.000Z',
      displayName: 'Maria Teste',
      email: null,
      id: 'contact-1',
      identities: [],
      label: 'Maria Teste',
      latestActivityAt: '2026-10-20T12:00:00.000Z',
      phone: null,
      phoneSource: null,
      provisional: false,
      registration: null,
      version: 1,
    },
    'contact-2': {
      createdAt: '2026-09-02T12:00:00.000Z',
      displayName: 'Gráfica Exemplo',
      email: 'compras@example.com',
      id: 'contact-2',
      identities: [],
      label: 'Gráfica Exemplo',
      latestActivityAt: '2026-10-19T12:00:00.000Z',
      phone: '5511977776666',
      phoneSource: 'manual',
      provisional: false,
      registration: null,
      version: 4,
    },
    'contact-3': {
      createdAt: '2026-09-03T12:00:00.000Z',
      displayName: 'Loja Completa',
      email: 'loja@example.com',
      id: 'contact-3',
      identities: [],
      label: 'Loja Completa',
      latestActivityAt: '2026-10-18T12:00:00.000Z',
      phone: '5511966665555',
      phoneSource: 'manual',
      provisional: false,
      registration: {
        city: 'São Paulo',
        complement: null,
        district: 'Bela Vista',
        document: '52998224725',
        instagram: null,
        legalName: 'Loja Completa',
        number: '10',
        personType: 'individual',
        postalCode: '01310100',
        state: 'SP',
        stateRegistration: null,
        street: 'Avenida Paulista',
      },
      version: 2,
    },
  };
  /** @param {any} contact */
  const status = (contact) =>
    isRegistrationComplete(contact.registration, contact)
      ? 'complete'
      : 'incomplete';
  /** @param {any} contact */
  const view = (contact) => ({
    ...contact,
    registrationStatus: status(contact),
  });
  /** @type {{body: any, key: string|undefined, id: string}[]} */
  const detailsWrites = [];
  /** @type {{body: any, key: string|undefined, id: string}[]} */
  const registrationWrites = [];
  /** @type {string[]} */
  const postalLookups = [];
  /** @type {string[]} */
  const postalUrls = [];
  /** @type {Record<string, number>} */
  const delays = {};
  let failNextRegistration = 0;

  await page.route('**/api/v1/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const path = requestUrl.pathname;
    const method = route.request().method();
    if (path === '/api/v1/sessions/current') {
      return route.fulfill({
        json: { user: { id: 'seller-1', name: 'Marina', capabilities: [] } },
      });
    }
    if (path === '/api/v1/events') {
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: 'retry: 60000\n\n',
      });
    }
    if (path === '/api/v1/contacts' && method === 'GET') {
      const items = Object.values(contacts).map((contact) => {
        const listed = { ...view(contact) };
        delete listed.registration;
        delete listed.email;
        return listed;
      });
      return route.fulfill({
        json: { items, nextCursor: null, totalCount: items.length },
      });
    }
    if (path.startsWith('/api/v1/postal-codes')) {
      if (path !== '/api/v1/postal-codes/lookup' || method !== 'POST') {
        return route.fulfill({ status: 405, json: {} });
      }
      const cep = String(route.request().postDataJSON()?.postalCode ?? '');
      postalLookups.push(cep);
      postalUrls.push(
        route
          .request()
          .url()
          .replace(/^https?:\/\/[^/]+/u, ''),
      );
      if (delays[cep]) {
        await new Promise((resolve) => setTimeout(resolve, delays[cep]));
      }
      try {
        if (cep === '01310100') {
          return await route.fulfill({
            json: {
              city: 'São Paulo',
              district: 'Bela Vista',
              postalCode: cep,
              state: 'SP',
              street: 'Avenida Paulista',
            },
          });
        }
        if (cep === '88888888') {
          return await route.fulfill({
            status: 503,
            json: { error: { code: 'POSTAL_CODE_UNAVAILABLE' } },
          });
        }
        return await route.fulfill({
          status: 404,
          json: { error: { code: 'POSTAL_CODE_NOT_FOUND' } },
        });
      } catch {
        // The page aborted an outdated lookup.
        return undefined;
      }
    }
    const match =
      /^\/api\/v1\/contacts\/([^/]+)(?:\/(details|registration))?$/u.exec(path);
    const contact = match ? contacts[match[1]] : null;
    if (match && !contact) {
      return route.fulfill({
        status: 404,
        json: { error: { code: 'CONTACT_NOT_FOUND' } },
      });
    }
    if (contact && !match?.[2] && method === 'GET') {
      return route.fulfill({
        json: {
          contact: view(contact),
          conversations: [],
          deals: [],
          identities: [],
        },
      });
    }
    if (contact && match?.[2] === 'details' && method === 'POST') {
      const body = route.request().postDataJSON();
      detailsWrites.push({
        body,
        id: contact.id,
        key: route.request().headers()['idempotency-key'],
      });
      if (body.expectedVersion !== contact.version) {
        return route.fulfill({
          status: 409,
          json: { error: { code: 'CONTACT_CONFLICT' } },
        });
      }
      contact.phone = body.phone;
      contact.phoneSource = 'manual';
      contact.email = body.email ?? null;
      contact.version += 1;
      return route.fulfill({
        json: {
          contact: {
            displayName: contact.displayName,
            email: contact.email,
            id: contact.id,
            label: contact.label,
            phone: contact.phone,
            version: contact.version,
          },
        },
      });
    }
    if (contact && match?.[2] === 'registration' && method === 'PUT') {
      const body = route.request().postDataJSON();
      registrationWrites.push({
        body,
        id: contact.id,
        key: route.request().headers()['idempotency-key'],
      });
      if (failNextRegistration > 0) {
        failNextRegistration -= 1;
        return route.fulfill({
          status: 503,
          json: { error: { code: 'SERVICE_UNAVAILABLE' } },
        });
      }
      if (body.expectedVersion !== contact.version) {
        return route.fulfill({
          status: 409,
          json: { error: { code: 'CONTACT_CONFLICT' } },
        });
      }
      contact.registration = body.registration;
      contact.version += 1;
      return route.fulfill({
        json: {
          contact: {
            id: contact.id,
            registration: contact.registration,
            registrationStatus: status(contact),
            version: contact.version,
          },
        },
      });
    }
    return route.fulfill({ status: 404, json: {} });
  });

  return {
    contacts,
    detailsWrites,
    postalLookups,
    postalUrls,
    registrationWrites,
    /** @param {string} cep @param {number} ms */
    delayPostalCode(cep, ms) {
      delays[cep] = ms;
    },
    failNextRegistration() {
      failNextRegistration = 1;
    },
    /** Another seller renames the client: the registration is untouched. */
    remoteRename() {
      contacts['contact-1'].displayName = 'Maria Renomeada';
      contacts['contact-1'].label = 'Maria Renomeada';
      contacts['contact-1'].version += 1;
    },
    /** Another seller saves the same client while the form is open. */
    remoteEdit() {
      contacts['contact-1'].registration = {
        ...Object.fromEntries(
          [
            'city',
            'complement',
            'district',
            'document',
            'instagram',
            'number',
            'personType',
            'postalCode',
            'state',
            'stateRegistration',
            'street',
          ].map((field) => [field, null]),
        ),
        legalName: 'Nome de outro vendedor',
      };
      contacts['contact-1'].version += 1;
    },
  };
}

/** @param {import('@playwright/test').Page} page */
function registration(page) {
  return page.getByRole('region', { name: 'Cadastro', exact: true });
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} target
 */
async function tabTo(page, target) {
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

test('CP-25 completes an individual registration by keyboard with the address from the CEP', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  await expect(section.getByText('Cadastro incompleto')).toBeVisible();
  await expect(
    page
      .getByRole('row', { name: /Maria Teste/u })
      .getByText('Cadastro completo'),
  ).toHaveCount(0);

  const open = section.getByRole('button', { name: 'Completar cadastro' });
  await open.focus();
  await page.keyboard.press('Enter');

  const individual = section.getByRole('radio', { name: 'Física' });
  await expect(individual).toBeFocused();
  await page.keyboard.press('Space');
  await expect(individual).toBeChecked();

  const cpf = section.getByRole('textbox', { name: 'CPF', exact: true });
  await tabTo(page, cpf);
  await expect(cpf).toHaveAttribute('inputmode', 'numeric');
  await page.keyboard.type('52998224725');

  const name = section.getByRole('textbox', { name: 'Nome completo' });
  await tabTo(page, name);
  await expect(cpf).toHaveValue('529.982.247-25');
  await expect(name).toHaveValue('');
  await page.keyboard.type('Maria Teste da Silva');

  await tabTo(page, section.getByRole('textbox', { name: '@ do Instagram' }));
  await page.keyboard.type('@Maria.Teste');
  await tabTo(
    page,
    section.getByRole('textbox', { name: 'Inscrição estadual' }),
  );
  await expect(
    section.getByRole('textbox', { name: 'Inscrição estadual' }),
  ).toHaveAccessibleDescription('Opcional para pessoa física.');
  await tabTo(page, section.getByRole('checkbox', { name: 'Isento' }));

  const cep = section.getByRole('textbox', { name: 'CEP' });
  await tabTo(page, cep);
  await page.keyboard.type('01310100');
  await expect(cep).toHaveAccessibleDescription(
    'Endereço preenchido pelo CEP. Confira.',
  );
  // The lookup only announces itself: focus never jumps away from the CEP.
  await expect(cep).toBeFocused();
  const city = section.getByRole('textbox', { name: 'Cidade' });
  await tabTo(page, city);
  await expect(city).toHaveValue('São Paulo');
  const state = section.getByRole('combobox', { name: 'UF' });
  await tabTo(page, state);
  await expect(state).toHaveValue('SP');
  const street = section.getByRole('textbox', { name: 'Endereço' });
  await tabTo(page, street);
  await expect(street).toHaveValue('Avenida Paulista');
  const district = section.getByRole('textbox', { name: 'Bairro' });
  await tabTo(page, district);
  await expect(district).toHaveValue('Bela Vista');
  const number = section.getByRole('textbox', { name: 'Número' });
  await tabTo(page, number);
  await expect(number).toHaveAccessibleDescription('S/N se não houver.');
  await page.keyboard.type('1000');

  await tabTo(page, section.getByRole('textbox', { name: 'Complemento' }));
  const phone = section.getByRole('textbox', { name: 'Celular' });
  await tabTo(page, phone);
  await page.keyboard.type('(11) 98888-7777');
  await tabTo(page, section.getByRole('textbox', { name: 'E-mail' }));
  await page.keyboard.type('maria@example.com');
  await page.keyboard.press('Enter');

  const edit = section.getByRole('button', { name: 'Editar cadastro' });
  await expect(edit).toBeFocused();
  await expect(section.getByText('Cadastro completo')).toBeVisible();
  await expect(section.getByText('529.982.247-25')).toBeVisible();
  await expect(section.getByText('@maria.teste')).toBeVisible();
  await expect(section.getByText('Avenida Paulista, 1000')).toBeVisible();
  await expect(section.getByText('Bela Vista · São Paulo/SP')).toBeVisible();
  await expect(section.getByText('CEP 01310-100')).toBeVisible();
  await expect(
    page
      .getByRole('row', { name: /Maria Teste/u })
      .getByText('Cadastro completo'),
  ).toBeVisible();

  expect(mock.postalLookups).toEqual(['01310100']);
  expect(mock.postalUrls).toEqual(['/api/v1/postal-codes/lookup']);
  expect(mock.detailsWrites).toHaveLength(1);
  expect(mock.detailsWrites[0].body).toEqual({
    email: 'maria@example.com',
    expectedVersion: 1,
    phone: '5511988887777',
  });
  expect(mock.detailsWrites[0].key).toBeTruthy();
  expect(mock.registrationWrites).toHaveLength(1);
  expect(mock.registrationWrites[0].key).toBeTruthy();
  expect(mock.registrationWrites[0].key).not.toBe(mock.detailsWrites[0].key);
  expect(mock.registrationWrites[0].body).toEqual({
    expectedVersion: 2,
    registration: {
      city: 'São Paulo',
      complement: null,
      district: 'Bela Vista',
      document: '52998224725',
      instagram: 'maria.teste',
      legalName: 'Maria Teste da Silva',
      number: '1000',
      personType: 'individual',
      postalCode: '01310100',
      state: 'SP',
      stateRegistration: null,
      street: 'Avenida Paulista',
    },
  });
  expect(page.url()).not.toContain('52998224725');
});

test('CP-25 saves a company with an alphanumeric CNPJ, Isento and S/N on a phone screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-2');
  const section = registration(page);
  await section.getByRole('button', { name: 'Completar cadastro' }).click();

  await section.getByRole('radio', { name: 'Jurídica' }).check();
  const cnpj = section.getByRole('textbox', { name: 'CNPJ', exact: true });
  await expect(cnpj).toHaveAttribute('inputmode', 'text');
  await cnpj.fill('12.abc.345/01de-35');
  await cnpj.blur();
  await expect(cnpj).toHaveValue('12.ABC.345/01DE-35');
  const legalName = section.getByRole('textbox', { name: 'Razão social' });
  await expect(legalName).toHaveAttribute('autocomplete', 'organization');
  await legalName.fill('Gráfica Exemplo Ltda');
  const ie = section.getByRole('textbox', { name: 'Inscrição estadual' });
  await section.getByRole('checkbox', { name: 'Isento' }).check();
  await expect(ie).toBeDisabled();
  await section.getByRole('textbox', { name: 'CEP' }).fill('01310-100');
  await expect(section.getByRole('textbox', { name: 'Cidade' })).toHaveValue(
    'São Paulo',
  );
  await section.getByRole('textbox', { name: 'Número' }).fill('s/n');

  const phone = section.getByRole('textbox', { name: 'Celular' });
  await expect(phone).toHaveAttribute('readonly', '');
  await expect(phone).toHaveValue('+55 (11) 97777-6666');
  await expect(phone).toHaveAccessibleDescription(
    'Celular já cadastrado. Ele não muda por aqui.',
  );
  await expect(section.getByRole('textbox', { name: 'E-mail' })).toHaveValue(
    'compras@example.com',
  );

  await section.getByRole('button', { name: 'Salvar cadastro' }).click();
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeFocused();
  await expect(section.getByText('Cadastro completo')).toBeVisible();
  await expect(section.getByText('12.ABC.345/01DE-35')).toBeVisible();
  await expect(section.getByText('Isento')).toBeVisible();
  await expect(section.getByText('Avenida Paulista, S/N')).toBeVisible();

  expect(mock.detailsWrites).toHaveLength(0);
  expect(mock.registrationWrites).toHaveLength(1);
  expect(mock.registrationWrites[0].body.expectedVersion).toBe(4);
  expect(mock.registrationWrites[0].body.registration).toMatchObject({
    document: '12ABC34501DE35',
    legalName: 'Gráfica Exemplo Ltda',
    number: 'S/N',
    personType: 'company',
    stateRegistration: 'ISENTO',
  });
});

test('CP-25 an invalid CPF stops the save with a focused error summary that leads to the field', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  await section.getByRole('button', { name: 'Completar cadastro' }).click();
  await section.getByRole('radio', { name: 'Física' }).check();
  const cpf = section.getByRole('textbox', { name: 'CPF', exact: true });
  await cpf.fill('529.982.247-24');
  await section.getByRole('textbox', { name: 'E-mail' }).fill('maria@');
  await section.getByRole('button', { name: 'Salvar cadastro' }).click();

  const summary = section.getByRole('group', {
    name: 'Revise 2 campos antes de salvar',
  });
  await expect(summary).toBeFocused();
  await expect(summary.getByRole('link')).toHaveText([
    'CPF: CPF inválido. Confira os 11 números.',
    'E-mail: Informe um e-mail válido, como nome@exemplo.com.',
  ]);
  await expect(cpf).toHaveAttribute('aria-invalid', 'true');
  await expect(cpf).toHaveAccessibleDescription(
    'CPF inválido. Confira os 11 números.',
  );

  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(cpf).toBeFocused();
  expect(mock.registrationWrites).toHaveLength(0);
  expect(mock.detailsWrites).toHaveLength(0);

  await cpf.fill('529.982.247-25');
  await section.getByRole('textbox', { name: 'E-mail' }).fill('');
  await section.getByRole('button', { name: 'Salvar cadastro' }).click();
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeFocused();
  expect(mock.registrationWrites).toHaveLength(1);
});

test('CP-28 a missing or unavailable CEP leaves the address to be typed, never overwriting it', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  const open = section.getByRole('button', { name: 'Completar cadastro' });
  await open.click();
  const cep = section.getByRole('textbox', { name: 'CEP' });
  const street = section.getByRole('textbox', { name: 'Endereço' });

  // A slow answer for an older CEP never lands after the newer one.
  mock.delayPostalCode('01310100', 800);
  await cep.fill('01310-100');
  await cep.fill('99999-999');
  await expect(
    section.getByText('CEP não encontrado. Preencha o endereço.'),
  ).toBeVisible();
  await expect(cep).toBeFocused();
  await page.waitForTimeout(900);
  await expect(street).toHaveValue('');
  await expect(
    section.getByText('CEP não encontrado. Preencha o endereço.'),
  ).toBeVisible();

  await cep.fill('88888-888');
  await expect(
    section.getByText('Consulta de CEP indisponível. Preencha o endereço.'),
  ).toBeVisible();
  await expect(street).toBeEditable();
  await street.fill('Rua Digitada');

  mock.delayPostalCode('01310100', 0);
  await cep.fill('01310-100');
  await expect(section.getByRole('textbox', { name: 'Cidade' })).toHaveValue(
    'São Paulo',
  );
  await expect(street).toHaveValue('Rua Digitada');
  await expect(cep).toBeFocused();

  // Esc belongs to the select while it is focused; the form stays open.
  const state = section.getByRole('combobox', { name: 'UF' });
  await state.focus();
  await page.keyboard.press('Escape');
  await expect(state).toBeFocused();
  await expect(
    section.getByRole('button', { name: 'Salvar cadastro' }),
  ).toBeVisible();

  await street.press('Escape');
  await expect(open).toBeFocused();
  expect(mock.registrationWrites).toHaveLength(0);
});

test('CP-27 a concurrent change keeps the draft and offers to reload the client', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  await section.getByRole('button', { name: 'Completar cadastro' }).click();
  await section.getByRole('radio', { name: 'Física' }).check();
  const cpf = section.getByRole('textbox', { name: 'CPF', exact: true });
  await cpf.fill('52998224725');
  mock.remoteEdit();
  await section.getByRole('button', { name: 'Salvar cadastro' }).click();

  const alert = section
    .getByRole('alert')
    .filter({ hasText: 'mudou enquanto você editava' });
  await expect(alert).toBeFocused();
  await expect(cpf).toHaveValue('529.982.247-25');
  await expect(
    section.getByRole('button', { name: 'Salvar cadastro' }),
  ).toBeDisabled();
  await alert.getByRole('button', { name: 'Recarregar cliente' }).click();
  await expect(alert).toContainText(
    'O cadastro salvo agora é diferente do que você abriu.',
  );
  await expect(alert).toBeFocused();
  await expect(cpf).toHaveValue('529.982.247-25');
  await expect(
    section.getByRole('button', { name: 'Salvar cadastro' }),
  ).toBeDisabled();

  await alert
    .getByRole('button', { name: 'Descartar rascunho e carregar o atual' })
    .click();
  await expect(
    section.getByText(
      'Seu rascunho foi descartado e o cadastro atual foi carregado.',
    ),
  ).toBeVisible();
  await expect(
    section.getByRole('textbox', { name: 'Nome completo' }),
  ).toHaveValue('Nome de outro vendedor');
  await expect(
    section.getByRole('textbox', { name: 'CPF ou CNPJ', exact: true }),
  ).toHaveValue('');
  await expect(
    section.getByRole('button', { name: 'Salvar cadastro' }),
  ).toBeEnabled();

  await section.getByRole('button', { name: 'Cancelar' }).click();
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeFocused();
  await expect(section.getByText('Nome de outro vendedor')).toBeVisible();
  expect(mock.registrationWrites).toHaveLength(1);
  expect(mock.registrationWrites[0].body.expectedVersion).toBe(1);
});

test('CP-27 a 409 caused by another part of the client keeps the draft and saves on the new version', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  await section.getByRole('button', { name: 'Completar cadastro' }).click();
  await section.getByRole('radio', { name: 'Física' }).check();
  const cpf = section.getByRole('textbox', { name: 'CPF', exact: true });
  await cpf.fill('52998224725');
  mock.remoteRename();
  const save = section.getByRole('button', { name: 'Salvar cadastro' });
  await save.click();
  const alert = section
    .getByRole('alert')
    .filter({ hasText: 'mudou enquanto você editava' });
  await expect(alert).toBeFocused();
  await alert.getByRole('button', { name: 'Recarregar cliente' }).click();

  const notice = section.getByRole('status').filter({
    hasText: 'Só outra parte do cliente mudou',
  });
  await expect(notice).toBeFocused();
  await expect(alert).toHaveCount(0);
  await expect(cpf).toHaveValue('529.982.247-25');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Maria Renomeada' }),
  ).toBeVisible();
  expect(
    mock.registrationWrites.map((write) => write.body.expectedVersion),
  ).toEqual([1, 2]);
  expect(mock.registrationWrites[1].key).not.toBe(
    mock.registrationWrites[0].key,
  );
});

test('CP-26 opening and saving without typing sends nothing; the contact name is only offered', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  const open = section.getByRole('button', { name: 'Completar cadastro' });
  await open.click();
  const name = section.getByRole('textbox', { name: 'Nome completo' });
  await expect(name).toHaveValue('');
  await section.getByRole('button', { name: 'Salvar cadastro' }).click();
  await expect(open).toBeFocused();
  expect(mock.registrationWrites).toHaveLength(0);
  expect(mock.detailsWrites).toHaveLength(0);

  await open.click();
  await section
    .getByRole('button', { name: 'Usar nome do contato: Maria Teste' })
    .click();
  await expect(name).toHaveValue('Maria Teste');
  await expect(name).toBeFocused();
  await expect(
    section.getByRole('button', { name: /Usar nome do contato/u }),
  ).toHaveCount(0);
});

test('CP-25 when only phone and e-mail were saved the ficha shows them and the retry skips them', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-1');
  const section = registration(page);
  await section.getByRole('button', { name: 'Completar cadastro' }).click();
  await section.getByRole('radio', { name: 'Física' }).check();
  await section
    .getByRole('textbox', { name: 'CPF', exact: true })
    .fill('52998224725');
  await section.getByRole('textbox', { name: 'Celular' }).fill('11988887777');
  await section
    .getByRole('textbox', { name: 'E-mail' })
    .fill('maria@example.com');
  mock.failNextRegistration();
  const save = section.getByRole('button', { name: 'Salvar cadastro' });
  await save.click();

  const alert = section.getByRole('alert').filter({
    hasText:
      'Celular e e-mail salvos; o restante do cadastro não foi salvo. Tente de novo.',
  });
  await expect(alert).toBeFocused();
  await expect(page.getByText('+55 (11) 98888-7777').first()).toBeVisible();
  await expect(page.getByText('maria@example.com')).toBeVisible();
  await expect(
    section.getByRole('textbox', { name: 'Celular' }),
  ).toHaveAttribute('readonly', '');
  await expect(page.getByText('Cadastro do cliente salvo.')).toHaveCount(0);

  await save.click();
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeFocused();
  expect(mock.detailsWrites).toHaveLength(1);
  expect(mock.registrationWrites).toHaveLength(2);
  expect(mock.registrationWrites[1].key).toBe(mock.registrationWrites[0].key);
  expect(mock.registrationWrites[1].body.expectedVersion).toBe(2);
});

test('CP-27 an unavailable API keeps what was typed and retries with the same key', async ({
  page,
}) => {
  const mock = await mockRegistrationApi(page);
  await page.goto('/clientes/contact-2');
  const section = registration(page);
  await section.getByRole('button', { name: 'Completar cadastro' }).click();
  await section.getByRole('textbox', { name: 'Nome completo' }).fill('Ana');
  mock.failNextRegistration();
  const save = section.getByRole('button', { name: 'Salvar cadastro' });
  await save.click();
  const alert = section.getByRole('alert').filter({
    hasText:
      'Não foi possível salvar agora. O que você digitou foi mantido; tente de novo.',
  });
  await expect(alert).toBeFocused();
  await expect(
    section.getByRole('textbox', { name: 'Nome completo' }),
  ).toHaveValue('Ana');

  await save.click();
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeFocused();
  expect(mock.registrationWrites).toHaveLength(2);
  expect(mock.registrationWrites[1].key).toBe(mock.registrationWrites[0].key);
  expect(mock.registrationWrites[1].body).toEqual(
    mock.registrationWrites[0].body,
  );
});

test('CP-26 the list marks only complete registrations', async ({ page }) => {
  await mockRegistrationApi(page);
  await page.goto('/clientes/contact-3');
  await expect(
    page
      .getByRole('row', { name: /Loja Completa/u })
      .getByText('Cadastro completo'),
  ).toBeVisible();
  for (const name of [/Maria Teste/u, /Gráfica Exemplo/u]) {
    await expect(
      page.getByRole('row', { name }).getByText('Cadastro completo'),
    ).toHaveCount(0);
  }
  const section = registration(page);
  await expect(section.getByText('Cadastro completo')).toBeVisible();
  await expect(section.getByText('Falta:')).toHaveCount(0);
  await expect(
    section.getByRole('button', { name: 'Editar cadastro' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Maria Teste' }).click();
  await expect(
    registration(page).getByText('Cadastro incompleto'),
  ).toBeVisible();
});

test('CP-25 read mode, form and error summary have no accessibility violations', async ({
  page,
}) => {
  await mockRegistrationApi(page);
  await page.goto('/clientes/contact-3');
  const section = registration(page);
  await expect(section.getByText('529.982.247-25')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await section.getByRole('button', { name: 'Editar cadastro' }).click();
  await section.getByRole('textbox', { name: 'CEP' }).fill('123');
  await section.getByRole('button', { name: 'Salvar cadastro' }).click();
  await expect(section.getByRole('group', { name: /Revise/u })).toBeFocused();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});
