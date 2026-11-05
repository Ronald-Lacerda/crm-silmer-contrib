import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  CHECKPOINT_NODES as names,
  createDailyCheckpointWorkflow,
  classifyCheckpointLookup,
  classifyCheckpointSend,
} from '../ops/n8n/workflows/create-daily-checkpoint-workflow.mjs';

const phone = '5511000000001';
const reservation = {
  authorized: true,
  checkpointId: 'synthetic-checkpoint',
  recipientId: 'synthetic-recipient',
  reservationId: 'synthetic-reservation',
  phone: '+' + phone,
  text: 'Resumo sintético',
};
const lookup = {
  statusCode: 200,
  body: [{ number: phone, exists: true, jid: phone + '@s.whatsapp.net' }],
};
const send = {
  statusCode: 201,
  body: {
    key: {
      fromMe: true,
      remoteJid: phone + '@s.whatsapp.net',
      id: 'synthetic-message',
    },
  },
};
const workflow = createDailyCheckpointWorkflow();
const node = (/** @type {string} */ name) =>
  workflow.nodes.find((/** @type {any} */ value) => value.name === name);
const outputs = (/** @type {string} */ name) =>
  workflow.connections[name].main.map((/** @type {any[]} */ port) =>
    port.map((edge) => edge.node),
  );

test('CHK: committed inactive workflow matches the generator without private bindings', async () => {
  const artifact = JSON.parse(
    await readFile(
      new URL(
        '../ops/n8n/workflows/daily-checkpoint.sanitized.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  assert.deepEqual(artifact, workflow);
});

test('CHK: inactive checkpoint template schedules 08h São Paulo and never retains payloads', () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.timezone, 'America/Sao_Paulo');
  assert.equal(
    node(names.schedule).parameters.rule.interval[0].expression,
    '0 8 * * *',
  );
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveExecutionProgress, false);
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal('pinData' in workflow, false);
  for (const http of workflow.nodes.filter(
    (/** @type {any} */ n) => n.type === 'n8n-nodes-base.httpRequest',
  )) {
    assert.equal(http.retryOnFail, false);
    assert.equal('maxTries' in http, false);
    assert.equal(
      http.parameters.options.redirect.redirect.followRedirects,
      false,
    );
  }
  assert.equal(node(names.prepare).parameters.jsonBody, '{}');
  assert.match(node(names.prepare).parameters.url, /DAILY_CHECKPOINT_CRM_URL/u);
  assert.match(
    node(names.lookup).parameters.url,
    /DAILY_CHECKPOINT_EVOLUTION_INSTANCE/u,
  );
  assert.equal(JSON.stringify(workflow).includes(phone), false);
});

test('CHK: transport is reachable only from a single-use authorized reservation and strict lookup', () => {
  assert.deepEqual(outputs(names.prepare), [[names.recipients]]);
  assert.deepEqual(outputs(names.recipients), [[names.reserve]]);
  assert.deepEqual(outputs(names.reserve), [[names.authorized]]);
  assert.deepEqual(outputs(names.authorized), [[names.lookup], []]);
  assert.deepEqual(outputs(names.lookup), [
    [names.validate],
    [names.lookupFailure],
  ]);
  assert.deepEqual(outputs(names.registered), [[names.send], [names.complete]]);
  assert.deepEqual(outputs(names.send), [[names.classify], [names.unknown]]);
  assert.deepEqual(outputs(names.classify), [[names.complete]]);
  assert.deepEqual(outputs(names.lookupFailure), [[names.complete]]);
  assert.deepEqual(outputs(names.unknown), [[names.complete]]);
  assert.equal(node(names.lookup).onError, 'continueErrorOutput');
  assert.equal(node(names.send).onError, 'continueErrorOutput');
  const pairs = vm.runInNewContext(
    `(()=>{${node(names.recipients).parameters.jsCode}})()`,
    {
      $input: {
        first: () => ({
          json: {
            checkpointId: 'checkpoint',
            recipients: [{ id: 'a' }, { id: 'b' }],
          },
        }),
      },
    },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(pairs)), [
    {
      json: { checkpointId: 'checkpoint', recipientId: 'a' },
      pairedItem: { item: 0 },
    },
    {
      json: { checkpointId: 'checkpoint', recipientId: 'b' },
      pairedItem: { item: 0 },
    },
  ]);
});

test('CHK: lookup rejects malformed/mismatched/ambiguous identities before transport', () => {
  assert.deepEqual(classifyCheckpointLookup(lookup, phone), {
    registered: true,
  });
  assert.deepEqual(
    classifyCheckpointLookup(
      { ...lookup, body: [{ ...lookup.body[0], exists: false }] },
      phone,
    ),
    { registered: false, status: 'failed', code: 'RECIPIENT_UNREGISTERED' },
  );
  for (const response of [
    undefined,
    { statusCode: 503, body: lookup.body },
    { statusCode: 200, body: [] },
    { statusCode: 200, body: [...lookup.body, ...lookup.body] },
    { statusCode: 200, body: [{ ...lookup.body[0], number: '5511000000002' }] },
  ]) {
    assert.deepEqual(classifyCheckpointLookup(response, phone), {
      registered: false,
      status: 'failed',
      code: 'RECIPIENT_LOOKUP_UNAVAILABLE',
    });
  }
});

test('CHK: accepted provider response identifies exact recipient; every ambiguous send becomes unknown', () => {
  assert.deepEqual(classifyCheckpointSend(send, phone), {
    status: 'sent',
    code: 'PROVIDER_ACCEPTED',
    providerMessageId: 'synthetic-message',
  });
  for (const response of [
    undefined,
    { statusCode: 500, body: send.body },
    { statusCode: 200, body: {} },
    {
      statusCode: 200,
      body: {
        ...send.body,
        key: { ...send.body.key, remoteJid: '5511000000002@s.whatsapp.net' },
      },
    },
    { statusCode: 200, body: { ...send.body, status: 'ERROR' } },
  ]) {
    assert.deepEqual(classifyCheckpointSend(response, phone), {
      status: 'outcome_unknown',
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
  }
});

test('CHK: generated Code/HTTP expressions execute without imports and preserve reservation fences', () => {
  const context = (/** @type {any} */ json) => ({
    $json: json,
    $: (/** @type {string} */ name) => {
      assert.equal(name, names.reserve);
      return { item: { json: reservation } };
    },
  });
  for (const [name, input, expected] of [
    [names.validate, lookup, { registered: true }],
    [
      names.classify,
      send,
      {
        status: 'sent',
        code: 'PROVIDER_ACCEPTED',
        providerMessageId: 'synthetic-message',
      },
    ],
  ]) {
    const result = vm.runInNewContext(
      `(()=>{${node(/** @type {string} */ (name)).parameters.jsCode}})()`,
      context(input),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { json: expected });
  }
  const evalBody = (/** @type {string} */ name, /** @type {any} */ json) =>
    vm.runInNewContext(
      '(' + node(name).parameters.jsonBody.slice(3, -2) + ')',
      context(json),
    );
  assert.deepEqual(JSON.parse(JSON.stringify(evalBody(names.lookup, {}))), {
    numbers: [phone],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(evalBody(names.send, {}))), {
    number: phone,
    text: reservation.text,
    linkPreview: false,
  });
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        evalBody(names.complete, {
          status: 'failed',
          code: 'RECIPIENT_LOOKUP_UNAVAILABLE',
        }),
      ),
    ),
    {
      checkpointId: reservation.checkpointId,
      recipientId: reservation.recipientId,
      reservationId: reservation.reservationId,
      status: 'failed',
      code: 'RECIPIENT_LOOKUP_UNAVAILABLE',
    },
  );
  const bound = createDailyCheckpointWorkflow({
    crmBaseUrl: 'https://crm.example.test/',
    evolutionBaseUrl: 'https://evolution.example.test/',
    evolutionInstance: 'synthetic instance',
    crmCredential: { id: 'crm-synthetic', name: 'CRM synthetic' },
    evolutionCredential: {
      id: 'evolution-synthetic',
      name: 'Evolution synthetic',
    },
  });
  assert.equal(bound.active, false);
  const provider = bound.nodes.find(
    (/** @type {any} */ value) => value.name === names.send,
  );
  assert.equal(
    vm.runInNewContext(provider.parameters.url.slice(3, -2)),
    'https://evolution.example.test/message/sendText/synthetic%20instance',
  );
  assert.deepEqual(provider.credentials.httpHeaderAuth, {
    id: 'evolution-synthetic',
    name: 'Evolution synthetic',
  });
});
