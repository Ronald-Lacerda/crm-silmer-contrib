import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { patchWahaInboundImages } from '../ops/n8n/patch-waha-inbound-images.mjs';

const INBOUND = 'CRM - Registrar inbound (MVP)';
const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const PREFIX = 'Inbox - Imagem recebida - ';
// Sanitized copy of the existing production URL guard. The patch clones it.
const lookupCode = String.raw`const validateWahaMediaUrl = (value, baseUrl) => {
  const prefix = baseUrl + '/api/files/';
  if (typeof value !== 'string' || !value.startsWith(prefix)) throw new Error('WAHA_MEDIA_URL_INVALID');
  const relative = value.slice(prefix.length);
  if (!relative || relative.length > 1024 || /[?#\\\x00-\x20]/.test(relative) || /%(?:2e|2f|5c|00)/i.test(relative)) throw new Error('WAHA_MEDIA_URL_INVALID');
  if (relative.split('/').some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9_@.%+-]+$/.test(part))) throw new Error('WAHA_MEDIA_URL_INVALID');
  return value;
};
return { json: { url: validateWahaMediaUrl($('Normalizar evento WhatsApp (MVP)').item.json.waha_media_url, 'http://waha:3000') } };`;
/** @returns {any} */
function fixture() {
  return {
    id: 'workflow-synthetic',
    active: true,
    name: 'Synthetic WAHA',
    settings: { saveDataSuccessExecution: 'none', executionOrder: 'v1' },
    nodes: [
      {
        id: 'normalizer',
        name: NORMALIZE,
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'preserved' },
      },
      {
        id: 'inbound',
        name: INBOUND,
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.5,
        position: [100, 200],
        credentials: {
          httpBasicAuth: { id: 'synthetic-bound-crm', name: 'CRM' },
        },
        parameters: {
          method: 'POST',
          url: 'https://crm.invalid/api/v1/integrations/n8n/messages/inbound',
          authentication: 'genericCredentialType',
          genericAuthType: 'httpBasicAuth',
          headerParameters: {
            parameters: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Idempotency-Key', value: 'old' },
              { name: 'X-Correlation-Id', value: 'old' },
              { name: 'X-Silmer-Workflow-Key', value: 'synthetic-key' },
              { name: 'X-Silmer-Workflow-Version', value: 'synthetic-version' },
              { name: 'X-Silmer-Execution-Id', value: '={{ $execution.id }}' },
            ],
          },
        },
      },
      {
        id: 'lookup',
        name: 'WhatsApp - Consultar mídia (MVP)',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: {
          mode: 'runOnceForEachItem',
          jsCode: lookupCode,
        },
      },
      {
        id: 'download',
        name: 'WhatsApp - Baixar mídia (MVP)',
        type: 'n8n-nodes-base.httpRequest',
        typeVersion: 4.5,
        credentials: { httpHeaderAuth: { id: 'synthetic-waha', name: 'WAHA' } },
        parameters: {
          method: 'GET',
          url: '={{ $json.url }}',
          authentication: 'genericCredentialType',
          genericAuthType: 'httpHeaderAuth',
          options: { timeout: 1000 },
        },
      },
      {
        id: 'reply',
        name: 'Rotear conversa registrada (MVP)',
        type: 'n8n-nodes-base.switch',
        parameters: { preserved: true },
      },
      {
        id: 'send',
        name: 'WhatsApp - Enviar resposta',
        type: 'n8n-nodes-base.httpRequest',
        parameters: { preserved: true },
      },
    ],
    connections: {
      [INBOUND]: {
        main: [
          [
            {
              node: 'Rotear conversa registrada (MVP)',
              type: 'main',
              index: 0,
            },
          ],
        ],
      },
      'Rotear conversa registrada (MVP)': {
        main: [
          [{ node: 'WhatsApp - Enviar resposta', type: 'main', index: 0 }],
        ],
      },
    },
  };
}
/** @param {any} workflow @param {string} suffix */
const added = (workflow, suffix) =>
  workflow.nodes.find((/** @type {any} */ n) => n.name === PREFIX + suffix);
/** @param {string} expression @param {any} normalized */
function condition(expression, normalized) {
  return vm.runInNewContext(expression.slice(3, -2), {
    $: () => ({ item: { json: normalized } }),
  });
}
/** @param {string} jsCode @param {any} item @param {Record<string,any>} upstream @param {Buffer} [bytes] */
async function run(
  jsCode,
  item,
  upstream,
  bytes = Buffer.from('synthetic-image'),
) {
  const result = await vm.runInNewContext(
    `(async function () { ${jsCode}\n }).call(context)`,
    {
      $json: item.json,
      $input: { item },
      $itemIndex: 0,
      $execution: { id: '42' },
      $: (/** @type {string} */ name) => ({ item: upstream[name] }),
      context: {
        helpers: {
          async getBinaryDataBuffer() {
            return bytes;
          },
        },
      },
    },
  );
  return JSON.parse(JSON.stringify(result));
}

test('INBOX-IMG-01: offline patch preserves original workflow and creates a branch with no path to sends', () => {
  const source = fixture();
  const before = structuredClone(source);
  const { workflow, addedNodeNames } = patchWahaInboundImages(source);
  assert.deepEqual(source, before);
  assert.deepEqual(workflow.nodes.slice(0, source.nodes.length), source.nodes);
  assert.deepEqual(workflow.settings, source.settings);
  assert.equal(workflow.active, source.active);
  assert.equal(workflow.id, source.id);
  assert.equal(addedNodeNames.length, 9);
  for (const [name, connections] of Object.entries(source.connections)) {
    if (name !== INBOUND)
      assert.deepEqual(workflow.connections[name], connections);
  }
  assert.deepEqual(
    workflow.connections[INBOUND].main[0].slice(0, -1),
    source.connections[INBOUND].main[0],
  );
  const pending = [PREFIX + 'Filtrar'];
  const visited = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    assert.ok(addedNodeNames.includes(/** @type {string} */ (name)));
    for (const output of workflow.connections[/** @type {string} */ (name)]
      ?.main ?? [])
      for (const edge of output) pending.push(edge.node);
  }
  assert.equal(visited.size, 9);
  assert.deepEqual(
    added(workflow, 'Baixar').credentials,
    source.nodes[3].credentials,
  );
  assert.deepEqual(
    added(workflow, 'Salvar no CRM').credentials,
    source.nodes[1].credentials,
  );
  assert.equal(
    added(workflow, 'Baixar').parameters.options.redirect.redirect
      .followRedirects,
    false,
  );
  assert.equal(
    added(workflow, 'Baixar').parameters.options.response.response
      .outputPropertyName,
    'data',
  );
});

test('INBOX-IMG-01: images are persisted during human mode and inbound replay, while other messages are excluded', () => {
  const { workflow } = patchWahaInboundImages(fixture());
  const expression = added(workflow, 'Filtrar').parameters.conditions
    .conditions[0].leftValue;
  const image = {
    channel: 'whatsapp',
    message_type: 'image',
    media_mime_type: 'image/png',
    waha_media_url: 'http://waha:3000/api/files/synthetic.png',
  };
  for (const mode of ['ai_active', 'human_active', 'handoff_pending']) {
    for (const duplicate of [true, false])
      assert.equal(condition(expression, { ...image, mode, duplicate }), true);
  }
  for (const overrides of [
    { channel: 'site_chat' },
    { message_type: 'text' },
    { message_type: 'audio' },
    { media_mime_type: 'text/html' },
  ])
    assert.equal(condition(expression, { ...image, ...overrides }), false);
});

test('INBOX-IMG-01: cloned WAHA URL validation rejects foreign origins, traversal, query strings and encoded escapes', async () => {
  const source = fixture();
  const { workflow } = patchWahaInboundImages(source);
  const code = added(workflow, 'Consultar URL').parameters.jsCode;
  assert.equal(code, source.nodes[2].parameters.jsCode);
  const upstream = {
    [NORMALIZE]: {
      json: { waha_media_url: 'http://waha:3000/api/files/session/image.png' },
    },
  };
  const valid = await run(code, { json: {} }, upstream);
  assert.equal(valid.json.url, 'http://waha:3000/api/files/session/image.png');
  for (const invalid of [
    'https://other.invalid/api/files/image.png',
    'http://waha:3000/api/files/../image.png',
    'http://waha:3000/api/files/session/%2e%2e/image.png',
    'http://waha:3000/api/files/session/image.png?token=x',
    'http://waha:3000/api/files/session/image.png#fragment',
    'http://waha:3000/api/files/session//image.png',
    'http://waha:3000/api/files/session/image%2f.png',
  ]) {
    upstream[NORMALIZE].json.waha_media_url = invalid;
    await assert.rejects(
      run(code, { json: {} }, upstream),
      /WAHA_MEDIA_URL_INVALID/u,
    );
  }
});

test('INBOX-IMG-01: upload preserves exact binary and stable metadata even if Crypto does not return binary', async () => {
  const { workflow } = patchWahaInboundImages(fixture());
  const bytes = Buffer.from('synthetic-png-bytes');
  const upstream = {
    [NORMALIZE]: {
      json: { event_id: 'synthetic-message-1', media_mime_type: 'image/png' },
    },
    [INBOUND]: {
      json: {
        conversation_id: 'conversation-synthetic',
        duplicate: true,
        mode: 'human_active',
      },
    },
  };
  const measured = await run(
    added(workflow, 'Medir').parameters.jsCode,
    {
      json: {},
      binary: {
        data: {
          id: 'binary-reference',
          fileName: 'untrusted-name',
          mimeType: 'text/html',
        },
      },
    },
    upstream,
    bytes,
  );
  assert.equal(measured.binary.data.id, 'binary-reference');
  assert.equal(measured.binary.data.fileName, 'imagem.png');
  assert.equal(measured.binary.data.mimeType, 'image/png');
  upstream[/** @type {keyof typeof upstream} */ (PREFIX + 'Medir')] = measured;
  const digest = createHash('sha256').update(bytes).digest('hex');
  const prepared = await run(
    added(workflow, 'Preparar anexo').parameters.jsCode,
    { json: { media_sha256: digest } },
    upstream,
  );
  assert.deepEqual(prepared.binary, measured.binary);
  assert.equal(prepared.json.content_sha256, digest);
  assert.equal(prepared.json.external_id, 'synthetic-message-1');
  assert.equal(prepared.json.idempotency_key, 'synthetic-message-1');
  assert.equal(prepared.json.correlation_id, '0000000000000042');
  assert.equal(prepared.json.conversation_id, 'conversation-synthetic');
  const replay = await run(
    added(workflow, 'Preparar anexo').parameters.jsCode,
    { json: { media_sha256: digest } },
    upstream,
  );
  assert.deepEqual(replay.json, prepared.json);
  upstream[NORMALIZE].json.event_id = 'x'.repeat(255);
  const fullLengthId = await run(
    added(workflow, 'Preparar anexo').parameters.jsCode,
    { json: { media_sha256: digest } },
    upstream,
  );
  assert.equal(fullLengthId.json.external_id, 'x'.repeat(255));
  assert.equal(fullLengthId.json.idempotency_key, 'x'.repeat(255));
  const upload = added(workflow, 'Salvar no CRM');
  assert.equal(
    vm.runInNewContext(upload.parameters.url.slice(3, -2), {
      $json: prepared.json,
    }),
    'https://crm.invalid/api/v1/integrations/n8n/conversations/conversation-synthetic/attachments',
  );
  assert.equal(upload.parameters.contentType, 'multipart-form-data');
  assert.deepEqual(upload.parameters.bodyParameters.parameters, [
    { name: 'schema_version', value: '1.0' },
    { name: 'external_id', value: '={{ $json.external_id }}' },
    { name: 'filename', value: '={{ $json.filename }}' },
    { name: 'mime_type', value: '={{ $json.mime_type }}' },
    {
      parameterType: 'formBinaryData',
      name: 'file',
      inputDataFieldName: 'data',
    },
  ]);
  const headers = Object.fromEntries(
    upload.parameters.headerParameters.parameters.map(
      (/** @type {any} */ h) => [h.name, h.value],
    ),
  );
  assert.equal(headers['Content-Type'], undefined);
  assert.equal(
    headers['X-Silmer-Content-SHA256'],
    '={{ $json.content_sha256 }}',
  );
  assert.equal(headers['X-Silmer-Workflow-Key'], 'synthetic-key');
  assert.equal(headers['X-Silmer-Workflow-Version'], 'synthetic-version');
  assert.equal(headers['X-Silmer-Execution-Id'], '={{ $execution.id }}');
  assert.deepEqual(added(workflow, 'SHA256').parameters, {
    action: 'hash',
    type: 'SHA256',
    binaryData: true,
    binaryPropertyName: 'data',
    encoding: 'hex',
    dataPropertyName: 'media_sha256',
  });
});

test('INBOX-IMG-01: empty/oversized media, missing binary and invalid digests fail before upload', async () => {
  const { workflow } = patchWahaInboundImages(fixture());
  const upstream = {
    [NORMALIZE]: {
      json: { event_id: 'synthetic', media_mime_type: 'image/png' },
    },
    [INBOUND]: { json: { conversation_id: 'conversation' } },
    [PREFIX + 'Medir']: { json: {} },
  };
  const measure = added(workflow, 'Medir').parameters.jsCode;
  const item = { json: {}, binary: { data: { id: 'synthetic-reference' } } };
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(5 * 1024 * 1024 + 1)])
    await assert.rejects(
      run(measure, item, upstream, bytes),
      /INBOUND_IMAGE_INVALID/u,
    );
  const atLimit = await run(
    measure,
    item,
    upstream,
    Buffer.alloc(5 * 1024 * 1024),
  );
  assert.equal(atLimit.binary.data.id, 'synthetic-reference');
  await assert.rejects(
    run(measure, { json: {} }, upstream),
    /INBOUND_IMAGE_MISSING/u,
  );
  await assert.rejects(
    run(
      added(workflow, 'Preparar anexo').parameters.jsCode,
      { json: { media_sha256: 'invalid' } },
      upstream,
    ),
    /INBOUND_IMAGE_METADATA_INVALID/u,
  );
});

test('INBOX-IMG-01: persistence failures reach only a redacted CRM failure, never message sending', async () => {
  const { workflow } = patchWahaInboundImages(fixture());
  const failure = added(workflow, 'Preparar falha');
  const result = await run(
    failure.parameters.jsCode,
    { json: { error: { message: 'private-data-must-not-leak' } } },
    { [INBOUND]: { json: { conversation_id: 'conversation-synthetic' } } },
  );
  assert.equal(result.json.payload.event_type, 'workflow.failed');
  assert.equal(result.json.payload.conversation_id, 'conversation-synthetic');
  assert.deepEqual(JSON.parse(JSON.stringify(result.json.payload.failure)), {
    code: 'INBOUND_MEDIA_STORE_FAILED',
  });
  assert.equal(
    JSON.stringify(result).includes('private-data-must-not-leak'),
    false,
  );
  assert.equal(result.json.payload.command_id, undefined);
  for (const suffix of [
    'Consultar URL',
    'Baixar',
    'Medir',
    'SHA256',
    'Preparar anexo',
    'Salvar no CRM',
  ])
    assert.deepEqual(workflow.connections[PREFIX + suffix].main[1], [
      { node: failure.name, type: 'main', index: 0 },
    ]);
});

test('INBOX-IMG-01: refuses Meta, ambiguous nodes, missing credential/headers and repeated patches', () => {
  for (const modify of [
    (/** @type {any} */ s) => {
      s.nodes[2].type = 'n8n-nodes-base.httpRequest';
    },
    (/** @type {any} */ s) => {
      s.nodes.push(structuredClone(s.nodes[1]));
    },
    (/** @type {any} */ s) => {
      delete s.nodes[1].credentials;
    },
    (/** @type {any} */ s) => {
      delete s.nodes[1].parameters.headerParameters;
    },
    (/** @type {any} */ s) => {
      s.nodes[1].parameters.url = 'https://other.invalid/wrong';
    },
  ]) {
    const source = fixture();
    modify(source);
    assert.throws(() => patchWahaInboundImages(source));
  }
  const { workflow } = patchWahaInboundImages(fixture());
  assert.throws(() => patchWahaInboundImages(workflow), /ALREADY_PRESENT/u);
});

test('INBOX-IMG-01: accepts the deployed constant URL expression without altering existing nodes', () => {
  for (const expression of [
    '={{ "https://crm.invalid" + "/api/v1/integrations/n8n/messages/inbound" }}',
    '={{"https://crm.invalid"+"/api/v1/integrations/n8n/messages/inbound"}}',
    '{{ \n "https://crm.invalid"\n+\n"/api/v1/integrations/n8n/messages/inbound"\n }}',
  ]) {
    const source = fixture();
    source.nodes[1].parameters.url = expression;
    source.nodes[3].parameters.url = '={{\n$json.url\n}}';
    const { workflow } = patchWahaInboundImages(source);
    assert.deepEqual(
      workflow.nodes.slice(0, source.nodes.length),
      source.nodes,
    );
    assert.equal(workflow.nodes[1].parameters.url, expression);
    const upload = added(workflow, 'Salvar no CRM');
    assert.equal(
      vm.runInNewContext(upload.parameters.url.slice(3, -2), {
        $json: { conversation_id: 'conversation-synthetic' },
      }),
      'https://crm.invalid/api/v1/integrations/n8n/conversations/conversation-synthetic/attachments',
    );
  }
});

test('INBOX-IMG-01: rejects dynamic or executable URL expressions and different endpoint paths', () => {
  for (const url of [
    '={{ $env.CRM_URL + "/api/v1/integrations/n8n/messages/inbound" }}',
    '={{ "https://crm.invalid" + getPath() }}',
    '={{ "https://crm.invalid" + "/api/v1/integrations/n8n/messages/inbound"; process.exit() }}',
    '={{ "https://crm.invalid" + "/api/v1/integrations/n8n/messages/" + "inbound" }}',
    '={{ `https://crm.invalid${path}` }}',
    '={{ "https://crm.invalid" + "/different/path" }}',
    '={{ "http://crm.invalid" + "/api/v1/integrations/n8n/messages/inbound" }}',
    '={{ "https://user:secret@crm.invalid" + "/api/v1/integrations/n8n/messages/inbound" }}',
    ['https://crm.invalid/api/v1/integrations/n8n/messages/inbound'],
  ]) {
    const source = fixture();
    source.nodes[1].parameters.url = url;
    assert.throws(
      () => patchWahaInboundImages(source),
      /FIXED_CRM_INBOUND_URL_REQUIRED/u,
    );
  }
  for (const url of [
    '={{ $json.url + "?extra=true" }}',
    '={{ getUrl() }}',
    '={{ $env.MEDIA_URL }}',
  ]) {
    const source = fixture();
    source.nodes[3].parameters.url = url;
    assert.throws(
      () => patchWahaInboundImages(source),
      /EXPECTED_WAHA_MEDIA_ADAPTER/u,
    );
  }
});

test('INBOX-IMG-01: CLI writes an exclusive offline review copy without changing input or printing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-waha-patch-'));
  const input = join(directory, 'source.json');
  const output = join(directory, 'review.json');
  const source = JSON.stringify(fixture());
  await writeFile(input, source);
  const command = new URL(
    '../ops/n8n/patch-waha-inbound-images.mjs',
    import.meta.url,
  );
  const runCli = () =>
    spawnSync(
      process.execPath,
      [command.pathname.replace(/^\/(\w:)/u, '$1'), input, output],
      { encoding: 'utf8' },
    );
  const result = runCli();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('nothing was published'), true);
  assert.equal(result.stdout.includes('synthetic-bound-crm'), false);
  assert.equal(await readFile(input, 'utf8'), source);
  assert.equal(
    JSON.parse(await readFile(output, 'utf8')).nodes.length,
    fixture().nodes.length + 9,
  );
  const originalOutput = await readFile(output, 'utf8');
  assert.notEqual(runCli().status, 0);
  assert.equal(await readFile(output, 'utf8'), originalOutput);
});
