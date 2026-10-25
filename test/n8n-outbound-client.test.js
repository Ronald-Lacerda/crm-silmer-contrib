import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalJsonStringify,
  classifyN8nCommandDeliveryFailure,
  createN8nCommandDeliveryClient,
  N8nCommandDeliveryError,
  sha256Hex,
} from '../modules/integration-reliability/src/index.js';

const COMMAND_ID = 'e8c63771-08dd-42c4-9053-ab3c82fd7377';

function command(overrides = {}) {
  const payload = {
    action: 'send_message',
    command_id: COMMAND_ID,
    conversation_id: '8c0bd046-f93c-4a8d-8e24-0bd36cf5d3ef',
    message: { text: 'conteudo pessoal', type: 'text' },
    schema_version: '1.0',
  };
  return {
    commandId: COMMAND_ID,
    payload,
    payloadHash: sha256Hex(canonicalJsonStringify(payload)),
    ...overrides,
  };
}

/** @param {number} status @param {Record<string, unknown>} [payload] */
function response(status, payload = {}) {
  return {
    json: async () => payload,
    status,
  };
}

test('uses outbound-only Basic credentials and replays the immutable bytes', async () => {
  /** @type {Array<{init: RequestInit, url: string}>} */
  const calls = [];
  const client = createN8nCommandDeliveryClient({
    clientId: 'crm-outbound',
    clientSecret: 'outbound-secret',
    endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
    fetchImpl: async (url, init) => {
      calls.push({ init, url: String(url) });
      return response(202, {
        accepted: true,
        command_id: COMMAND_ID,
      });
    },
    replaySafe: true,
  });

  await client.deliver(command());
  await client.deliver(command());

  assert.equal(calls.length, 2);
  const first = calls[0];
  const second = calls[1];
  assert.ok(first);
  assert.ok(second);
  const headers = /** @type {Record<string, string>} */ (first.init.headers);
  assert.equal(first.init.body, second.init.body);
  assert.equal(headers['idempotency-key'], COMMAND_ID);
  assert.equal(
    headers.authorization,
    `Basic ${Buffer.from('crm-outbound:outbound-secret').toString('base64')}`,
  );
  assert.equal(headers['x-silmer-signature'], undefined);
});

test('permits HTTP only for an explicitly enabled loopback development endpoint', async () => {
  const client = createN8nCommandDeliveryClient({
    allowInsecureLocal: true,
    clientId: 'crm-local',
    clientSecret: 'local-secret',
    endpoint: 'http://127.0.0.1:5678/webhook/silmer/local-panel-command',
    fetchImpl: async () =>
      response(202, { accepted: true, command_id: COMMAND_ID }),
  });
  await client.deliver(command());

  for (const endpoint of [
    'http://127.0.0.1:5678/webhook/silmer/local-panel-command',
    'http://n8n.example.test/webhook/silmer/panel-command',
  ]) {
    await assert.rejects(
      async () =>
        createN8nCommandDeliveryClient({
          clientId: 'crm-local',
          clientSecret: 'local-secret',
          endpoint,
        }),
      /credential-free HTTPS/u,
    );
  }
});

test('canonical encoding is stable and detects a changed payload before fetch', async () => {
  assert.equal(
    canonicalJsonStringify({ z: 1, nested: { z: false, a: true }, a: 2 }),
    '{"a":2,"nested":{"a":true,"z":false},"z":1}',
  );
  let fetched = false;
  const client = createN8nCommandDeliveryClient({
    clientId: 'crm-outbound',
    clientSecret: 'outbound-secret',
    endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
    fetchImpl: async () => {
      fetched = true;
      return response(202, { accepted: true });
    },
  });
  const changed = command({ payloadHash: '0'.repeat(64) });
  await assert.rejects(
    client.deliver(changed),
    (error) =>
      error instanceof N8nCommandDeliveryError &&
      error.code === 'N8N_COMMAND_PAYLOAD_CHANGED',
  );
  assert.equal(fetched, false);
});

test('network failure exposes only a bounded technical error and replay policy', async () => {
  const personalData = 'cliente@example.test +55 27 99999-9999';
  const client = createN8nCommandDeliveryClient({
    clientId: 'crm-outbound',
    clientSecret: 'super-secret-value',
    endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
    fetchImpl: async () => {
      throw new Error(personalData);
    },
  });

  await assert.rejects(client.deliver(command()), (error) => {
    assert.ok(error instanceof N8nCommandDeliveryError);
    assert.equal(error.code, 'N8N_COMMAND_NETWORK_ERROR');
    assert.equal(error.retryable, true);
    assert.equal(error.retrySafe, false);
    const exposed = JSON.stringify(error);
    assert.doesNotMatch(exposed, /cliente|99999|super-secret/iu);
    assert.doesNotMatch(error.message, /cliente|99999|super-secret/iu);
    return true;
  });
});

test('aborts a command request at the configured timeout', async () => {
  const client = createN8nCommandDeliveryClient({
    clientId: 'crm-outbound',
    clientSecret: 'outbound-secret',
    endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
    fetchImpl: async (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    timeoutMs: 1,
  });

  await assert.rejects(client.deliver(command()), (error) => {
    assert.ok(error instanceof N8nCommandDeliveryError);
    assert.equal(error.code, 'N8N_COMMAND_TIMEOUT');
    assert.equal(error.outcomeKnown, false);
    return true;
  });
});

test('classifies definitive rejection separately from unavailable remote', async () => {
  for (const fixture of [
    {
      code: 'N8N_COMMAND_HTTP_401',
      outcomeKnown: true,
      replaySafe: false,
      retrySafe: false,
      retryable: false,
      status: 401,
    },
    ...[403, 404, 405].map((status) => ({
      code: `N8N_COMMAND_HTTP_${status}`,
      outcomeKnown: true,
      replaySafe: false,
      retrySafe: false,
      retryable: false,
      status,
    })),
    {
      code: 'N8N_COMMAND_REJECTED',
      outcomeKnown: true,
      replaySafe: false,
      retrySafe: false,
      retryable: false,
      status: 400,
    },
    {
      code: 'N8N_COMMAND_REMOTE_UNAVAILABLE',
      outcomeKnown: false,
      replaySafe: false,
      retrySafe: false,
      retryable: true,
      status: 503,
    },
    {
      code: 'N8N_COMMAND_REMOTE_UNAVAILABLE',
      outcomeKnown: false,
      replaySafe: true,
      retrySafe: true,
      retryable: true,
      status: 503,
    },
  ]) {
    const client = createN8nCommandDeliveryClient({
      clientId: 'crm-outbound',
      clientSecret: 'outbound-secret',
      endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
      fetchImpl: async () => response(fixture.status),
      replaySafe: fixture.replaySafe,
    });
    await assert.rejects(client.deliver(command()), (error) => {
      assert.ok(error instanceof N8nCommandDeliveryError);
      assert.equal(error.code, fixture.code);
      assert.equal(error.outcomeKnown, fixture.outcomeKnown);
      assert.equal(error.retryable, fixture.retryable);
      assert.equal(error.retrySafe, fixture.retrySafe);
      return true;
    });
  }
});

test('does not accept an acknowledgement for another command', async () => {
  const client = createN8nCommandDeliveryClient({
    clientId: 'crm-outbound',
    clientSecret: 'outbound-secret',
    endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
    fetchImpl: async () =>
      response(202, {
        accepted: true,
        command_id: 'different-command-id',
      }),
  });

  await assert.rejects(client.deliver(command()), (error) => {
    assert.ok(error instanceof N8nCommandDeliveryError);
    assert.equal(error.code, 'N8N_COMMAND_ACK_MISMATCH');
    assert.equal(error.outcomeKnown, false);
    assert.equal(error.retrySafe, false);
    return true;
  });
});

test('missing or malformed acknowledgements require reconciliation even when replay is enabled', async () => {
  const invalidPayloads = [
    {},
    null,
    [],
    { message: 'Workflow was started' },
    { command_id: COMMAND_ID },
    { accepted: 'true', command_id: COMMAND_ID },
    { accepted: true },
    { accepted: true, command_id: null },
    { accepted: true, command_id: '' },
    { accepted: true, command_id: 'different-command-id' },
  ];
  for (const status of [200, 202]) {
    for (const payload of invalidPayloads) {
      const client = createN8nCommandDeliveryClient({
        clientId: 'crm-outbound',
        clientSecret: 'outbound-secret',
        endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
        fetchImpl: async () => ({ status, json: async () => payload }),
        replaySafe: true,
      });
      await assert.rejects(client.deliver(command()), (error) => {
        assert.ok(error instanceof N8nCommandDeliveryError);
        const failure = classifyN8nCommandDeliveryFailure(error, {
          effectStarted: true,
        });
        assert.equal(failure.outcome, 'outcome_unknown');
        assert.equal(failure.retryable, false);
        assert.equal(failure.retrySafe, false);
        assert.equal(error.outcomeKnown, false);
        return true;
      });
    }
    const client = createN8nCommandDeliveryClient({
      clientId: 'crm-outbound',
      clientSecret: 'outbound-secret',
      endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
      fetchImpl: async () => ({
        status,
        json: async () => {
          throw new SyntaxError('empty or malformed remote body');
        },
      }),
      replaySafe: true,
    });
    await assert.rejects(client.deliver(command()), (error) => {
      assert.ok(error instanceof N8nCommandDeliveryError);
      assert.equal(error.code, 'N8N_COMMAND_ACK_INVALID');
      assert.equal(
        classifyN8nCommandDeliveryFailure(error, { effectStarted: true })
          .outcome,
        'outcome_unknown',
      );
      assert.equal(error.retrySafe, false);
      return true;
    });
  }
});

test('accepts versioned workflow acknowledgements for sends, callbacks and state actions', async () => {
  for (const status of [200, 202]) {
    for (const action of ['send_message', 'take_over', 'close']) {
      for (const acknowledgement of [
        { accepted: true, command_id: COMMAND_ID },
        { accepted: true, duplicate: true, command_id: COMMAND_ID },
        {
          accepted: true,
          duplicate: false,
          command_id: COMMAND_ID,
          message_id: 'wamid.synthetic',
        },
      ]) {
        const payload = { ...command().payload, action };
        const client = createN8nCommandDeliveryClient({
          clientId: 'crm-outbound',
          clientSecret: 'outbound-secret',
          endpoint: 'https://n8n.example.test/webhook/silmer/panel-command',
          fetchImpl: async () => response(status, acknowledgement),
        });
        const result = await client.deliver(
          command({
            payload,
            payloadHash: sha256Hex(canonicalJsonStringify(payload)),
          }),
        );
        assert.equal(result.statusCode, status);
        assert.equal(result.duplicate, acknowledgement.duplicate === true);
        assert.equal(
          result.providerExternalId,
          acknowledgement.message_id ?? COMMAND_ID,
        );
      }
    }
  }
});
