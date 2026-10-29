import assert from 'node:assert/strict';
import test from 'node:test';

import { createApi } from '../apps/api/src/app.js';
import { createOperationReadRuntime } from '../apps/api/src/operation-runtime.js';
import {
  PostalCodeLookupError,
  PostgresContactReadRepository,
  ViaCepPostalCodeClient,
  decryptContactRegistration,
  encryptContactDetails,
  encryptContactRegistration,
} from '../modules/contacts/src/index.js';
import { PostgresIdempotencyRecordStore } from '../modules/integration-reliability/src/index.js';
import { createSafeLogger } from '../modules/shared/src/index.js';

const KEY = Buffer.alloc(32, 7);
const ENVIRONMENT = Object.freeze({
  CONTACT_IDENTITY_ENVELOPE_KEY: KEY.toString('base64url'),
  CONTACT_IDENTITY_LOOKUP_KEY: Buffer.alloc(32, 8).toString('base64url'),
  HANDOFF_ENVELOPE_KEY: KEY.toString('base64url'),
  INBOX_MESSAGE_ENVELOPE_KEY: KEY.toString('base64url'),
  IDEMPOTENCY_ENVELOPE_KEY: Buffer.alloc(32, 9).toString('base64url'),
  OPERATION_CURSOR_HMAC_KEY: KEY.toString('base64url'),
});

const REGISTRATION = Object.freeze({
  personType: 'company',
  document: '12.ABC.345/01DE-35',
  legalName: 'Silmer Uniformes Ltda',
  instagram: '@silmer.uniformes',
  stateRegistration: 'ISENTO',
  postalCode: '01310-100',
  city: 'São Paulo',
  state: 'SP',
  street: 'Avenida Paulista',
  district: 'Bela Vista',
  number: '1000',
  complement: 'Sala 1',
});
const PRIVATE_VALUES =
  /12ABC34501DE35|12\.ABC|Silmer Uniformes|silmer\.uniformes|Paulista|Bela Vista|01310|Sala 1/u;

/**
 * In-memory stand-in for the tables the command touches. A failed
 * transaction restores the snapshot taken when it began.
 * @param {{email?: string|null, phone?: string|null, whatsapp?: boolean}} [contact]
 */
function fakeDatabase(contact = {}) {
  /** @type {{contacts: Map<string, any>, [key: string]: any}} */
  let state = {
    contacts: new Map([
      [
        'contact-1',
        {
          contact_details_envelope:
            contact.phone || contact.email
              ? encryptContactDetails(
                  { email: contact.email ?? null, phone: contact.phone ?? '' },
                  KEY,
                )
              : null,
          id: 'contact-1',
          registration_envelope: null,
          registration_fields_complete: false,
          updated_at: '2026-10-28T10:00:00.000Z',
          version: 3,
        },
      ],
    ]),
    events: /** @type {any[]} */ ([]),
    audits: /** @type {any[]} */ ([]),
    idempotency: new Map(),
    whatsapp: new Set(contact.whatsapp ? ['contact-1'] : []),
  };
  /** @type {string[]} */
  const statements = [];
  const database = {
    statements,
    get state() {
      return state;
    },
    /** @param {string} sql @param {any[]} [values] */
    async query(sql, values = []) {
      statements.push(`${sql} ${JSON.stringify(values)}`);
      if (sql.includes('INSERT INTO crm.idempotency_records')) {
        const id = `${values[0]}|${values[1]}`;
        if (state.idempotency.has(id)) return { rows: [] };
        state.idempotency.set(id, {
          action: values[4],
          actor_id: values[3],
          correlation_id: values[9],
          fingerprint: values[2],
          reason: values[8],
          response: null,
          status: 'pending',
          target_id: values[6],
          target_type: values[5],
          version: values[7],
        });
        return { rows: [{ inserted: true }] };
      }
      if (sql.includes('UPDATE crm.idempotency_records')) {
        const record = state.idempotency.get(`${values[0]}|${values[1]}`);
        record.status = 'completed';
        record.response = JSON.parse(values[2]);
        return { rows: [{ completed: true }] };
      }
      if (sql.includes('FROM crm.idempotency_records')) {
        const record = state.idempotency.get(`${values[0]}|${values[1]}`);
        return { rows: record ? [{ ...record }] : [] };
      }
      if (sql.includes('FROM crm.contacts WHERE id = $1 FOR UPDATE')) {
        const row = state.contacts.get(values[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (sql.includes('UPDATE crm.contacts')) {
        const row = state.contacts.get(values[0]);
        row.registration_envelope = JSON.parse(values[1]);
        row.registration_fields_complete = values[2];
        row.version += 1;
        row.updated_at = values[3];
        return { rows: [{ id: row.id, version: row.version }] };
      }
      if (sql.includes('INSERT INTO crm.audit_events')) {
        state.audits.push(values);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO crm.domain_events')) {
        state.events.push(values);
        return { rows: [] };
      }
      if (sql.includes('crm.contact_identities')) {
        return { rows: [{ found: state.whatsapp.has(values[0]) }] };
      }
      throw new Error('unexpected query');
    },
    /** @param {(client: any) => Promise<any>} work */
    async transaction(work) {
      const snapshot = state;
      state = structuredClone(state);
      try {
        return await work(database);
      } catch (error) {
        state = snapshot;
        throw error;
      }
    },
  };
  return database;
}

/**
 * With `identity`, writes go through the runtime's real authorizeWrite
 * (origin, session cookie and CSRF) instead of an always-allow stub.
 * @param {ReturnType<typeof fakeDatabase>} database
 * @param {{postalCodeClient?: any, identity?: any}} [options]
 */
function harness(database, options = {}) {
  /** @type {string[]} */
  const logs = [];
  const operations = createOperationReadRuntime(database, {
    environment: ENVIRONMENT,
    ...options,
  });
  const realWrites = Boolean(options.identity);
  /** @type {any[]} */
  const authorizations = [];
  const api = createApi(
    {},
    {
      logger: createSafeLogger({
        service: 'crm-silmer-api',
        sink: (/** @type {unknown} */ line) => logs.push(JSON.stringify(line)),
      }),
      operations: {
        ...operations,
        async authorizeRead(/** @type {any} */ input) {
          authorizations.push(input);
          return { actor: { id: 'seller-1' } };
        },
        async authorizeWrite(/** @type {any} */ input) {
          authorizations.push(input);
          return realWrites
            ? operations.authorizeWrite(input)
            : { actor: { id: 'seller-1' } };
        },
      },
    },
  );
  return { api, authorizations, logs, operations };
}

const WRITE_HEADERS = Object.freeze({
  cookie: 'crm_session=session',
  origin: 'https://crm.example.test',
  'x-csrf-token': 'csrf',
});

/**
 * @param {any} api @param {any} payload @param {string} [key]
 * @param {Record<string, string>} [headers]
 */
function putRegistration(
  api,
  payload,
  key = 'registration-key-1',
  headers = WRITE_HEADERS,
) {
  return api.inject({
    headers: { ...headers, 'idempotency-key': key },
    method: 'PUT',
    payload,
    url: '/api/v1/contacts/contact-1/registration',
  });
}

/**
 * @param {any} api @param {unknown} payload
 * @param {Record<string, string>} [headers]
 */
function lookupPostalCode(api, payload, headers = WRITE_HEADERS) {
  return api.inject({
    headers,
    method: 'POST',
    payload: /** @type {any} */ (payload),
    url: '/api/v1/postal-codes/lookup',
  });
}

test('PUT registration stores an encrypted, versioned registration without PII in audit, event or logs', async () => {
  const database = fakeDatabase({
    email: 'cliente@example.test',
    phone: '5511999999999',
  });
  const { api, authorizations, logs } = harness(database);
  const response = await putRegistration(api, {
    expectedVersion: 3,
    registration: REGISTRATION,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.equal(authorizations[0].action, 'contact.rename');
  const { contact } = response.json();
  assert.equal(contact.id, 'contact-1');
  assert.equal(contact.version, 4);
  assert.equal(contact.registrationStatus, 'complete');
  assert.equal(contact.registration.document, '12ABC34501DE35');
  assert.equal(contact.registration.instagram, 'silmer.uniformes');
  assert.equal(contact.registration.postalCode, '01310100');

  const row = database.state.contacts.get('contact-1');
  assert.equal(row.registration_fields_complete, true);
  assert.doesNotMatch(
    JSON.stringify(row.registration_envelope),
    PRIVATE_VALUES,
  );
  assert.deepEqual(
    decryptContactRegistration(row.registration_envelope, KEY),
    contact.registration,
  );
  assert.equal(database.state.audits.length, 1);
  assert.equal(database.state.audits[0][2], 'contact.registration.updated');
  assert.equal(database.state.audits[0][6], 'CONTACT_REGISTRATION');
  assert.equal(database.state.events.length, 1);
  assert.equal(database.state.events[0][2], 4);
  assert.deepEqual(JSON.parse(database.state.events[0][3]), {
    contactId: 'contact-1',
  });
  const record = [...database.state.idempotency.values()][0];
  assert.match(record.fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(record.reason, 'CONTACT_REGISTRATION');
  assert.doesNotMatch(
    JSON.stringify([...database.state.idempotency.values()]),
    PRIVATE_VALUES,
  );
  assert.doesNotMatch(
    JSON.stringify([database.state.audits, database.state.events, logs]),
    PRIVATE_VALUES,
  );
  assert.doesNotMatch(database.statements.join('\n'), PRIVATE_VALUES);
});

test('a registration without celular or e-mail stays incomplete', async () => {
  const noEmail = harness(fakeDatabase({ phone: '5511999999999' }));
  const first = await putRegistration(noEmail.api, {
    expectedVersion: 3,
    registration: REGISTRATION,
  });
  assert.equal(first.json().contact.registrationStatus, 'incomplete');

  const whatsappPhone = harness(
    fakeDatabase({ email: 'cliente@example.test', whatsapp: true }),
  );
  const second = await putRegistration(whatsappPhone.api, {
    expectedVersion: 3,
    registration: REGISTRATION,
  });
  assert.equal(second.json().contact.registrationStatus, 'complete');

  const partial = harness(
    fakeDatabase({ email: 'cliente@example.test', phone: '5511999999999' }),
  );
  const third = await putRegistration(partial.api, {
    expectedVersion: 3,
    registration: { ...REGISTRATION, stateRegistration: null },
  });
  assert.equal(third.json().contact.registrationStatus, 'incomplete');
});

test('PUT registration reports the first invalid field by code and name, never the value', async () => {
  const database = fakeDatabase();
  const { api } = harness(database);
  /** @type {Array<[Record<string, unknown>, string, string]>} */
  const cases = [
    [{ personType: 'person' }, 'INVALID_PERSON_TYPE', 'personType'],
    [{ document: '52998224725' }, 'INVALID_PERSON_TYPE', 'personType'],
    [
      { personType: 'individual', document: '52998224724' },
      'INVALID_DOCUMENT',
      'document',
    ],
    [{ legalName: 'A', instagram: '..' }, 'INVALID_LEGAL_NAME', 'legalName'],
    [{ instagram: 'a..b' }, 'INVALID_INSTAGRAM', 'instagram'],
    [
      { stateRegistration: '#' },
      'INVALID_STATE_REGISTRATION',
      'stateRegistration',
    ],
    [{ postalCode: '00000000' }, 'INVALID_POSTAL_CODE', 'postalCode'],
    [{ city: 'c'.repeat(81) }, 'INVALID_CITY', 'city'],
    [{ state: 'XX', street: '' }, 'INVALID_STATE', 'state'],
    [{ street: 's'.repeat(151) }, 'INVALID_STREET', 'street'],
    [{ district: 'd'.repeat(81) }, 'INVALID_DISTRICT', 'district'],
    [{ number: '12345678901' }, 'INVALID_ADDRESS_NUMBER', 'number'],
    [{ complement: 7 }, 'INVALID_COMPLEMENT', 'complement'],
  ];
  for (const [registration, code, field] of cases) {
    const response = await putRegistration(api, {
      expectedVersion: 3,
      registration,
    });
    assert.equal(response.statusCode, 400, code);
    assert.deepEqual(response.json(), { error: { code, field } });
  }
  for (const payload of [
    { expectedVersion: 3, registration: { cpf: '52998224725' } },
    { expectedVersion: 3, registration: REGISTRATION, extra: true },
    { expectedVersion: 3 },
    { expectedVersion: 0, registration: REGISTRATION },
    { expectedVersion: 3, registration: [] },
  ]) {
    const response = await putRegistration(api, payload);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), { error: { code: 'INVALID_REQUEST' } });
  }
  const noKey = await api.inject({
    headers: {
      cookie: 'crm_session=session',
      origin: 'https://crm.example.test',
      'x-csrf-token': 'csrf',
    },
    method: 'PUT',
    payload: { expectedVersion: 3, registration: REGISTRATION },
    url: '/api/v1/contacts/contact-1/registration',
  });
  assert.equal(noKey.statusCode, 400);
  assert.equal(database.state.contacts.get('contact-1').version, 3);
  assert.equal(database.state.idempotency.size, 0);
  assert.equal(database.state.audits.length, 0);
});

test('PUT registration enforces the expected version and the contact existence', async () => {
  const database = fakeDatabase();
  const { api, operations } = harness(database);
  const stale = await putRegistration(api, {
    expectedVersion: 2,
    registration: REGISTRATION,
  });
  assert.equal(stale.statusCode, 409);
  assert.deepEqual(stale.json(), { error: { code: 'CONTACT_CONFLICT' } });
  // The failed command left no idempotency record, so the key can be retried.
  assert.equal(database.state.idempotency.size, 0);
  assert.equal(database.state.events.length, 0);

  await assert.rejects(
    operations.setContactRegistration({
      actor: { id: 'seller-1' },
      contactId: 'contact-missing',
      correlationId: 'request-1',
      expectedVersion: 1,
      idempotencyKey: 'registration-key-2',
      registration: {},
    }),
    { code: 'CONTACT_NOT_FOUND', statusCode: 404 },
  );
  const retried = await putRegistration(api, {
    expectedVersion: 3,
    registration: REGISTRATION,
  });
  assert.equal(retried.statusCode, 200);
});

test('PUT registration replays the same key and rejects the key with other content', async () => {
  const database = fakeDatabase({
    email: 'cliente@example.test',
    phone: '5511999999999',
  });
  const { api } = harness(database);
  const payload = { expectedVersion: 3, registration: REGISTRATION };
  const first = await putRegistration(api, payload);
  const replay = await putRegistration(api, payload);
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.deepEqual(replay.json(), first.json());
  assert.equal(replay.json().contact.registration.document, '12ABC34501DE35');
  // The immutable idempotency record keeps only id, version and status.
  const [record] = [...database.state.idempotency.values()];
  const stored = await new PostgresIdempotencyRecordStore({
    database,
    envelopeKey: Buffer.alloc(32, 9),
  }).get({ key: 'registration-key-1', scope: 'contact.registration.update' });
  assert.deepEqual(stored?.response, {
    id: 'contact-1',
    registrationStatus: 'complete',
    version: 4,
  });
  assert.doesNotMatch(
    JSON.stringify([record, stored]),
    /personType|document|legalName|instagram|stateRegistration|postalCode|"city"|"state"|street|district|"number"|complement|"registration"/u,
  );
  assert.equal(database.state.contacts.get('contact-1').version, 4);
  assert.equal(database.state.audits.length, 1);
  assert.equal(database.state.events.length, 1);

  const reused = await putRegistration(api, {
    expectedVersion: 3,
    registration: { ...REGISTRATION, number: '1001' },
  });
  assert.equal(reused.statusCode, 409);
  assert.deepEqual(reused.json(), {
    error: { code: 'IDEMPOTENCY_KEY_REUSED' },
  });
  // PUT replaces the whole registration: omitted fields become null.
  const replaced = await putRegistration(
    api,
    { expectedVersion: 4, registration: { personType: 'individual' } },
    'registration-key-3',
  );
  assert.equal(replaced.statusCode, 200);
  assert.equal(replaced.json().contact.version, 5);
  assert.equal(replaced.json().contact.registrationStatus, 'incomplete');
  assert.deepEqual(
    Object.entries(replaced.json().contact.registration).filter(
      ([, value]) => value !== null,
    ),
    [['personType', 'individual']],
  );
});

test('the detail returns the registration and the list only its status', async () => {
  /** @type {any} */
  const registration = {
    personType: 'individual',
    document: '52998224725',
    legalName: 'Maria da Silva',
    instagram: null,
    stateRegistration: null,
    postalCode: '01310100',
    city: 'São Paulo',
    state: 'SP',
    street: 'Avenida Paulista',
    district: 'Bela Vista',
    number: 'S/N',
    complement: null,
  };
  const contactRow = {
    contact_details_envelope: encryptContactDetails(
      { email: 'cliente@example.test', phone: '5511999999999' },
      KEY,
    ),
    created_at: '2026-10-28T10:00:00.000Z',
    display_name: 'Maria',
    id: 'contact-1',
    latest_activity_at: '2026-10-28T10:00:00.000Z',
    provisional: false,
    registration_envelope: encryptContactRegistration(registration, KEY),
    registration_fields_complete: true,
    updated_at: '2026-10-28T10:00:00.000Z',
    version: 4,
  };
  /** @type {string[]} */
  const queries = [];
  const repository = new PostgresContactReadRepository({
    database: {
      async query(/** @type {string} */ sql) {
        queries.push(sql);
        if (sql.includes('count(*)')) return { rows: [{ count: 1 }] };
        if (sql.includes('WITH contact_page')) {
          const listRow = Object.fromEntries(
            Object.entries(contactRow).filter(
              ([column]) => column !== 'registration_envelope',
            ),
          );
          return { rows: [listRow] };
        }
        if (sql.includes('FROM crm.contacts WHERE id=$1'))
          return { rows: [contactRow] };
        return { rows: [] };
      },
    },
    envelopeKey: KEY,
    lookupKey: Buffer.alloc(32, 8),
  });
  const detail = await repository.get('contact-1');
  assert.deepEqual(detail.contact.registration, registration);
  assert.equal(detail.contact.registrationStatus, 'complete');

  const page = await repository.list({ after: null, limit: 10 });
  assert.equal(page.items[0].registrationStatus, 'complete');
  assert.equal('registration' in page.items[0], false);
  const listQueries = queries.filter(
    (sql) => sql.includes('WITH contact_page') || sql.includes('count(*)'),
  );
  assert.equal(listQueries.length, 2);
  assert.ok(listQueries.every((sql) => !sql.includes('registration_envelope')));
  assert.ok(listQueries.every((sql) => !sql.includes('contact.*')));

  const never = await new PostgresContactReadRepository({
    database: {
      async query(/** @type {string} */ sql) {
        if (sql.includes('FROM crm.contacts WHERE id=$1'))
          return {
            rows: [
              {
                ...contactRow,
                registration_envelope: null,
                registration_fields_complete: false,
              },
            ],
          };
        return { rows: [] };
      },
    },
    envelopeKey: KEY,
    lookupKey: Buffer.alloc(32, 8),
  }).get('contact-1');
  assert.equal(never.contact.registration, null);
  assert.equal(never.contact.registrationStatus, 'incomplete');
});

test('postal code lookup is an authorized, private read that never reaches the network', async () => {
  /** @type {string[]} */
  const lookups = [];
  const outcomes = new Map([
    [
      '01310100',
      async () => ({
        city: 'São Paulo',
        district: 'Bela Vista',
        postalCode: '01310100',
        state: 'SP',
        street: 'Avenida Paulista',
      }),
    ],
    [
      '99999999',
      async () => {
        throw new PostalCodeLookupError(404, 'POSTAL_CODE_NOT_FOUND');
      },
    ],
    [
      '22222222',
      async () => {
        throw new PostalCodeLookupError(503, 'POSTAL_CODE_UNAVAILABLE');
      },
    ],
    [
      '33333333',
      async () => {
        throw new Error('unexpected adapter failure');
      },
    ],
  ]);
  const { api, authorizations, logs } = harness(fakeDatabase(), {
    postalCodeClient: {
      async lookup(/** @type {string} */ postalCode) {
        lookups.push(postalCode);
        return /** @type {any} */ (outcomes.get(postalCode))();
      },
    },
  });
  /** @param {unknown} postalCode */
  const get = (postalCode) => lookupPostalCode(api, { postalCode });

  const found = await get('01310-100');
  assert.equal(found.statusCode, 200);
  assert.equal(found.headers['cache-control'], 'private, no-store');
  assert.equal(authorizations[0].action, 'contact.read');
  assert.equal(authorizations[0].csrfToken, 'csrf');
  assert.deepEqual(found.json(), {
    city: 'São Paulo',
    district: 'Bela Vista',
    postalCode: '01310100',
    state: 'SP',
    street: 'Avenida Paulista',
  });
  const missing = await get('99999999');
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), {
    error: { code: 'POSTAL_CODE_NOT_FOUND' },
  });
  for (const postalCode of ['22222222', '33333333']) {
    const unavailable = await get(postalCode);
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.json(), {
      error: { code: 'POSTAL_CODE_UNAVAILABLE' },
    });
  }
  for (const postalCode of [
    '1234567',
    '12345-67',
    'abcdefgh',
    '00000000',
    '12.345-678',
    12345678,
    null,
  ]) {
    const invalid = await get(postalCode);
    assert.equal(invalid.statusCode, 400, String(postalCode));
    assert.deepEqual(invalid.json(), {
      error: { code: 'INVALID_POSTAL_CODE' },
    });
  }
  assert.deepEqual((await lookupPostalCode(api, {})).json(), {
    error: { code: 'INVALID_POSTAL_CODE' },
  });
  for (const payload of [{ postalCode: '01310100', extra: 1 }, []]) {
    const invalid = await lookupPostalCode(api, payload);
    assert.equal(invalid.statusCode, 400);
    assert.deepEqual(invalid.json(), { error: { code: 'INVALID_REQUEST' } });
  }
  // The CEP never travels in the URL, so the old path no longer exists.
  const legacy = await api.inject({
    headers: WRITE_HEADERS,
    method: 'GET',
    url: '/api/v1/postal-codes/01310100',
  });
  assert.equal(legacy.statusCode, 404);
  assert.deepEqual(lookups, ['01310100', '99999999', '22222222', '33333333']);
  assert.doesNotMatch(logs.join('\n'), /01310|99999999|22222222/u);
});

test('postal code lookup is rate limited like the private contact search', async () => {
  const { api } = harness(fakeDatabase(), {
    postalCodeClient: {
      async lookup() {
        throw new PostalCodeLookupError(404, 'POSTAL_CODE_NOT_FOUND');
      },
    },
  });
  let last;
  for (let attempt = 0; attempt < 31; attempt += 1) {
    last = await lookupPostalCode(api, { postalCode: '99999999' });
  }
  assert.equal(last?.statusCode, 429);
});

/**
 * Identity stub with the production contract: origin is checked by the
 * runtime, a missing session cookie never reaches it, and a wrong or missing
 * CSRF token is refused here with 403.
 * @param {string[]} calls
 */
function identityStub(calls) {
  return {
    allowedOrigins: ['https://crm.example.test'],
    async authorizeOperational(/** @type {any} */ input) {
      calls.push(input.action);
      if (input.sessionToken !== 'session' || input.csrfToken !== 'csrf') {
        throw Object.assign(new Error('FORBIDDEN'), {
          code: 'FORBIDDEN',
          statusCode: 403,
        });
      }
      return { actor: { id: 'seller-1' } };
    },
  };
}

const REFUSED_HEADERS = Object.freeze({
  'without CSRF': {
    cookie: 'crm_session=session',
    origin: 'https://crm.example.test',
  },
  'with a wrong CSRF': { ...WRITE_HEADERS, 'x-csrf-token': 'other' },
  'without a session': {
    origin: 'https://crm.example.test',
    'x-csrf-token': 'csrf',
  },
  'from another origin': {
    ...WRITE_HEADERS,
    origin: 'https://evil.example.test',
  },
});

test('PUT registration refused by authorization writes nothing', async () => {
  const database = fakeDatabase({
    email: 'cliente@example.test',
    phone: '5511999999999',
  });
  /** @type {string[]} */
  const identityCalls = [];
  const { api } = harness(database, { identity: identityStub(identityCalls) });
  for (const [label, headers] of Object.entries(REFUSED_HEADERS)) {
    const response = await putRegistration(
      api,
      { expectedVersion: 3, registration: REGISTRATION },
      'registration-refused',
      headers,
    );
    // A write session failure is 403, never 401 (authorizeWrite contract).
    assert.equal(response.statusCode, 403, label);
    assert.deepEqual(response.json(), { error: { code: 'FORBIDDEN' } });
  }
  // Session-less and foreign-origin requests stop before the identity port.
  assert.deepEqual(identityCalls, ['contact.rename', 'contact.rename']);
  assert.ok(
    database.statements.every(
      (statement) =>
        !/UPDATE crm\.contacts|crm\.idempotency_records|crm\.audit_events|crm\.domain_events/u.test(
          statement,
        ),
    ),
  );
  assert.equal(database.state.idempotency.size, 0);
  assert.equal(database.state.audits.length, 0);
  assert.equal(database.state.contacts.get('contact-1').version, 3);

  const allowed = await putRegistration(api, {
    expectedVersion: 3,
    registration: REGISTRATION,
  });
  assert.equal(allowed.statusCode, 200);
});

test('postal code lookup refused by authorization never calls ViaCEP', async () => {
  /** @type {string[]} */
  const fetches = [];
  /** @type {string[]} */
  const identityCalls = [];
  const { api } = harness(fakeDatabase(), {
    identity: identityStub(identityCalls),
    postalCodeClient: new ViaCepPostalCodeClient({
      fetchImpl: async (url) => {
        fetches.push(url.href);
        return new globalThis.Response(
          JSON.stringify({
            cep: '01310-100',
            localidade: 'São Paulo',
            uf: 'SP',
          }),
          { status: 200 },
        );
      },
    }),
  });
  for (const [label, headers] of Object.entries(REFUSED_HEADERS)) {
    const response = await lookupPostalCode(
      api,
      { postalCode: '01310100' },
      headers,
    );
    assert.equal(response.statusCode, 403, label);
    assert.deepEqual(response.json(), { error: { code: 'FORBIDDEN' } });
  }
  assert.deepEqual(identityCalls, ['contact.read', 'contact.read']);
  assert.deepEqual(fetches, []);

  const allowed = await lookupPostalCode(api, { postalCode: '01310-100' });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers['cache-control'], 'private, no-store');
  assert.deepEqual(fetches, ['https://viacep.com.br/ws/01310100/json/']);
});

test('the contact detail is private and not stored by caches', async () => {
  const api = createApi(
    {},
    {
      logger: createSafeLogger({ service: 'crm-silmer-api', sink: () => {} }),
      operations: {
        async authorizeRead() {
          return { actor: { id: 'seller-1' } };
        },
        async getContact(/** @type {any} */ input) {
          return { contact: { id: input.contactId } };
        },
        async listContacts() {
          return { items: [], nextCursor: null, totalCount: 0 };
        },
      },
    },
  );
  const detail = await api.inject({
    headers: {
      cookie: 'crm_session=session',
      origin: 'https://crm.example.test',
    },
    method: 'GET',
    url: '/api/v1/contacts/contact-1',
  });
  assert.equal(detail.statusCode, 200);
  assert.equal(detail.headers['cache-control'], 'private, no-store');
  assert.equal(detail.headers.vary, 'Origin, Cookie');
  // The list keeps its revalidating cache policy: only a status is exposed.
  const list = await api.inject({
    headers: {
      cookie: 'crm_session=session',
      origin: 'https://crm.example.test',
    },
    method: 'GET',
    url: '/api/v1/contacts',
  });
  assert.equal(list.headers['cache-control'], 'private, no-cache');
});
