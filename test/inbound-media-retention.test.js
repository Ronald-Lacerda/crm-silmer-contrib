import assert from 'node:assert/strict';
import test from 'node:test';
import { createN8nApiRuntime } from '../apps/api/src/n8n-runtime.js';

const NOW = new Date('2026-10-28T18:00:00Z');
const key = Buffer.alloc(32, 91).toString('base64');

/** @param {any} message */
function harness(message) {
  const inserted = /** @type {any[][]} */ ([]);
  let stores = 0;
  const stop = new Error('synthetic-stop-after-retention-check');
  const database = {
    async query(/** @type {string} */ sql, /** @type {any[]} */ values) {
      if (sql.includes('SELECT message.id')) return { rows: [message] };
      inserted.push(values);
      return {
        rows: [
          {
            id: values[0],
            availability_status: 'metadata_only',
            metadata_fingerprint: values[7],
          },
        ],
      };
    },
    async transaction(/** @type {Function} */ work) {
      return work(database);
    },
  };
  return {
    inserted,
    stores: () => stores,
    stop,
    runtime: createN8nApiRuntime(database, {
      environment: {
        N8N_INTEGRATION_ENVELOPE_KEY: key,
        CONTACT_IDENTITY_ENVELOPE_KEY: key,
        CONTACT_IDENTITY_LOOKUP_KEY: key,
        INBOX_MESSAGE_ENVELOPE_KEY: key,
      },
      clock: () => NOW,
      mediaVolume: /** @type {any} */ ({
        async store() {
          stores++;
          throw stop;
        },
      }),
    }),
  };
}

const input = {
  conversationId: 'conversation-synthetic',
  externalId: 'message-synthetic',
  contentSha256: 'a'.repeat(64),
  filename: 'image.png',
  mimeType: 'image/png',
  size: 12,
  stream: Buffer.from('synthetic'),
};

test('PRV-03: delayed attachment upload keeps original message receipt and expiry', async () => {
  const fixture = harness({
    id: 'message-synthetic',
    message_type: 'image',
    created_at: '2026-10-26T18:00:00Z',
    terminal_at: null,
    provider: 'meta',
    provider_account_id: 'account-synthetic',
  });
  await assert.rejects(fixture.runtime.storeAttachment(input), fixture.stop);
  assert.equal(
    fixture.inserted[0][8].toISOString(),
    '2026-10-26T18:00:00.000Z',
  );
  assert.equal(
    fixture.inserted[0][9].toISOString(),
    '2026-11-02T18:00:00.000Z',
  );
  assert.equal(fixture.stores(), 1);
});

for (const [
  name,
  values,
] of /** @type {Array<[string, Record<string, any>]>} */ ([
  ['seven-day deadline', { created_at: '2026-10-21T18:00:00Z' }],
  ['closed journey', { created_at: '2026-10-28T17:00:00Z', terminal_at: NOW }],
]))
  test(`PRV-03: recovery after ${name} cannot restart retention`, async () => {
    const fixture = harness({
      id: 'message-synthetic',
      message_type: 'image',
      ...values,
    });
    await assert.rejects(
      fixture.runtime.storeAttachment(input),
      (error) =>
        /** @type {any} */ (error).statusCode === 410 &&
        /** @type {any} */ (error).code === 'ATTACHMENT_EXPIRED',
    );
    assert.deepEqual(fixture.inserted, []);
    assert.equal(fixture.stores(), 0);
  });
