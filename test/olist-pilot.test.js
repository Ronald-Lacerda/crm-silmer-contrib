import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertOlistPilotActor,
  olistConfiguration,
  createOlistRepository,
} from '../modules/olist/src/index.js';

test('OLIST-T17: OAuth redirect uses the canonical APP_ORIGIN list without accepting similar origins', () => {
  const environment = {
    APP_ORIGIN: 'https://crm.example.test,https://admin.example.test',
    OLIST_ENABLED: 'true',
    OLIST_CLIENT_ID: 'synthetic-pilot-client',
    OLIST_CLIENT_SECRET: 'synthetic-pilot-secret',
    OLIST_EXPECTED_ACCOUNT_DOCUMENT: '12345678000199',
    OLIST_REDIRECT_URI: 'https://admin.example.test/olist',
    OLIST_ENVELOPE_KEY: Buffer.alloc(32, 1).toString('base64'),
    OLIST_IDENTITY_HMAC_KEY: Buffer.alloc(32, 2).toString('base64'),
  };
  assert.equal(olistConfiguration(environment).configured, true);
  for (const origins of [
    ' https://crm.example.test , https://admin.example.test ',
    'https://ADMIN.EXAMPLE.TEST:443,https://crm.example.test',
    'https://admin.example.test,https://admin.example.test',
  ])
    assert.equal(
      olistConfiguration({ ...environment, APP_ORIGIN: origins }).configured,
      true,
    );
  for (const redirect of [
    'https://admin.example.test.attacker.test/olist',
    'https://admin-example.test/olist',
    'https://admin.example.test:444/olist',
    'https://other.example.test/olist',
    'https://admin.example.test/olist?scope=changed',
  ])
    assert.equal(
      olistConfiguration({ ...environment, OLIST_REDIRECT_URI: redirect })
        .configured,
      false,
    );
  for (const origins of [
    '',
    ' ',
    'https://admin.example.test,',
    ',https://admin.example.test',
    'https://admin.example.test,invalid-origin',
    'https://admin.example.test,http://crm.example.test',
    'https://admin.example.test,ftp://crm.example.test',
  ])
    assert.equal(
      olistConfiguration({ ...environment, APP_ORIGIN: origins }).configured,
      false,
    );
});

test('OLIST-48/T17: private pilot list is explicit and fails closed', () => {
  for (const value of [
    '',
    ' ',
    ',pilot',
    'pilot@example.test',
    'pilot user',
    Array(17).fill('pilot').join(','),
  ]) {
    const config = olistConfiguration({ OLIST_PILOT_USER_IDS: value });
    assert.deepEqual(config.pilotUserIds, []);
    assert.throws(
      () =>
        assertOlistPilotActor(config.pilotUserIds, { actor: { id: 'pilot' } }),
      { code: 'FORBIDDEN' },
    );
  }
  const config = olistConfiguration({
    OLIST_PILOT_USER_IDS: ' pilot,other,pilot ',
  });
  assert.deepEqual(config.pilotUserIds, ['pilot', 'other']);
  assertOlistPilotActor(config.pilotUserIds, { actor: { id: 'pilot' } });
  assert.throws(
    () =>
      assertOlistPilotActor(config.pilotUserIds, {
        actor: {
          id: 'pilot-similar',
          olistEnabled: true,
          capabilities: ['COMMERCIAL_ADMIN'],
        },
      }),
    { code: 'FORBIDDEN' },
  );
  assert.ok(Object.isFrozen(config.pilotUserIds));
});

test('OLIST-48/T17: persistence rejects out-of-pilot export before SQL or effect reservation', async () => {
  let queries = 0;
  const database = {
    transaction: async (/** @type {any} */ work) =>
      work({
        query: async () => {
          queries++;
          throw new Error('No SQL should be reached');
        },
      }),
  };
  const repository = createOlistRepository(database, {
    envelopeKey: Buffer.alloc(32, 1),
    hmacKey: Buffer.alloc(32, 2),
    pilotUserIds: [],
  });
  await assert.rejects(
    repository.findExport({
      actor: { id: 'outside', kind: 'human' },
      accountKey: 'a'.repeat(64),
      contextKey: 'b'.repeat(64),
      orderId: 'synthetic',
    }),
    { code: 'FORBIDDEN' },
  );
  assert.equal(queries, 0);
});
