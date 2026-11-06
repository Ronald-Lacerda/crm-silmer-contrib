import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  createDurableMetaWebhookRuntime,
  createServerApi,
} from '../apps/api/src/server.js';
import { createOperationalHealth } from '../apps/api/src/operational-health.js';

const DATABASE = /** @type {any} */ (
  Object.freeze({
    async close() {},
    async query() {
      return { rows: [] };
    },
    /** @param {(database: any) => Promise<any>} work */
    async transaction(work) {
      return work(this);
    },
  })
);
const KEY = Buffer.alloc(32, 17).toString('base64url');

test('keeps the durable webhook disabled when no Meta configuration exists', () => {
  assert.equal(createDurableMetaWebhookRuntime(DATABASE, {}), undefined);
});

test('fails closed on partial webhook secrets or an invalid envelope key', () => {
  assert.throws(
    () =>
      createDurableMetaWebhookRuntime(DATABASE, {
        META_APP_SECRET: 'synthetic-app-secret-at-least-32-characters',
        META_VERIFY_TOKEN: 'synthetic-verify-token-at-least-32-chars',
        META_WHATSAPP_BUSINESS_ACCOUNT_ID: 'synthetic-account',
        META_WHATSAPP_PHONE_NUMBER_ID: 'synthetic-phone',
      }),
    /META_WEBHOOK_PAYLOAD_ENVELOPE_KEY/u,
  );
  assert.throws(
    () =>
      createDurableMetaWebhookRuntime(DATABASE, {
        META_APP_SECRET: 'synthetic-app-secret-at-least-32-characters',
        META_VERIFY_TOKEN: 'synthetic-verify-token-at-least-32-chars',
        META_WHATSAPP_BUSINESS_ACCOUNT_ID: 'synthetic-account',
        META_WHATSAPP_PHONE_NUMBER_ID: 'synthetic-phone',
        META_WEBHOOK_PAYLOAD_ENVELOPE_KEY: 'not-base64url!',
      }),
    /META_WEBHOOK_PAYLOAD_ENVELOPE_KEY/u,
  );
});

test('wires the production route only with PostgreSQL and every secret', async () => {
  const environment = {
    META_APP_SECRET: 'synthetic-app-secret-at-least-32-characters',
    META_VERIFY_TOKEN: 'synthetic-verify-token-at-least-32-chars',
    META_WHATSAPP_BUSINESS_ACCOUNT_ID: 'synthetic-account',
    META_WHATSAPP_PHONE_NUMBER_ID: 'synthetic-phone',
    META_WEBHOOK_PAYLOAD_ENVELOPE_KEY: KEY,
  };
  const runtime = createDurableMetaWebhookRuntime(DATABASE, environment);
  assert.ok(runtime);
  assert.equal(runtime.verifyToken, environment.META_VERIFY_TOKEN);

  const api = createServerApi({ database: DATABASE, environment });
  const denied = await api.inject({
    method: 'GET',
    url: '/api/v1/webhooks/meta/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=challenge',
  });
  assert.equal(denied.statusCode, 403);
  await api.close();
});

test('rejects a signed callback outside the configured Meta account scope', async () => {
  let transactions = 0;
  const database = {
    ...DATABASE,
    /** @param {(database: any) => Promise<any>} work */
    async transaction(work) {
      transactions += 1;
      return work(this);
    },
  };
  const appSecret = 'synthetic-app-secret-at-least-32-characters';
  const environment = {
    META_APP_SECRET: appSecret,
    META_VERIFY_TOKEN: 'synthetic-verify-token-at-least-32-chars',
    META_WHATSAPP_BUSINESS_ACCOUNT_ID: 'allowed-account',
    META_WHATSAPP_PHONE_NUMBER_ID: 'allowed-phone',
    META_WEBHOOK_PAYLOAD_ENVELOPE_KEY: KEY,
  };
  const rawBody = Buffer.from(
    JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'unexpected-account',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'unexpected-phone' },
                messages: [
                  {
                    from: 'synthetic-sender',
                    id: 'wamid.synthetic',
                    timestamp: '1788350400',
                    type: 'text',
                    text: { body: 'synthetic message' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }),
  );
  const api = createServerApi({
    database,
    environment,
    // Count only webhook transactions, independently from periodic health work.
    operationalHealth: createOperationalHealth({
      sample: async () => ({ worker: true, queue: true, commands: true }),
    }),
  });
  const response = await api.inject({
    method: 'POST',
    url: '/api/v1/webhooks/meta/whatsapp',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`,
    },
    payload: rawBody,
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.body, '');
  assert.equal(transactions, 0);
  await api.close();
});
