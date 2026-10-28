import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  convertWahaEvent,
  createWahaWorkflow,
  validateWahaEvent,
  validateWahaMediaUrl,
} from '../ops/n8n/workflows/create-waha-workflow.mjs';

const source = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const config = {
  ownNumber: '5511000000000',
  baseUrl: 'http://schedule_silmer-waha:3000',
  session: 'default',
  apiCredentialId: 'synthetic-api-credential',
  webhookCredentialId: 'synthetic-hook-credential',
};
const workflow = createWahaWorkflow(source, config);
const nodes = new Map(
  workflow.nodes.map((/** @type {any} */ node) => [node.name, node]),
);
/** @param {any} [extra] */
function event(extra = {}) {
  return {
    session: 'default',
    engine: 'WEBJS',
    me: { id: '5511000000000@c.us' },
    event: 'message',
    timestamp: 1793100000000,
    payload: {
      id: 'false_5511000000001@c.us_SYNTHETIC',
      from: '5511000000001@c.us',
      fromMe: false,
      body: 'Quero dez camisetas',
      hasMedia: false,
      timestamp: 1793100000,
    },
    ...extra,
  };
}
/** @param {string} name @param {any} json @param {any} [upstream] @param {any} [binary] */
async function runCode(name, json, upstream = {}, binary = {}) {
  return vm.runInNewContext(
    `(async function(){ ${nodes.get(name).parameters.jsCode} }).call(ctx)`,
    {
      $json: json,
      $: (/** @type {string} */ key) => ({ item: upstream[key] }),
      $input: { item: { json, binary }, all: () => [{ json, binary }] },
      $itemIndex: 0,
      $execution: { id: '42' },
      ctx: {
        helpers: {
          getBinaryDataBuffer: async () => Buffer.from('synthetic-media'),
        },
      },
    },
  );
}
/** @param {string} name @param {number} [output] */
const targets = (name, output = 0) =>
  (workflow.connections[name]?.main?.[output] ?? []).map(
    (/** @type {any} */ edge) => edge.node,
  );

test('WAHA-01: transformer preserves all original IDs, domain nodes, site/panel webhook identities and source', () => {
  const original = structuredClone(source);
  for (const node of original.nodes) node.id = 'synthetic:' + node.name;
  const before = JSON.stringify(original);
  const result = createWahaWorkflow(original, config);
  assert.equal(JSON.stringify(original), before);
  for (const previous of original.nodes) {
    const adapted = result.nodes.find(
      (/** @type {any} */ node) => node.name === previous.name,
    );
    assert.equal(adapted.id, previous.id);
    if (
      previous.name.startsWith('CRM -') ||
      previous.name.startsWith('Site -') ||
      previous.name.startsWith('Painel -') ||
      previous.name.includes('Reservar envio') ||
      previous.name === 'Atendente virtual Silmer (MVP)'
    ) {
      // Only the technical workflow version header may change.
      const expected = structuredClone(previous);
      if (expected.name === 'Site - Direcionar para WhatsApp (MVP)')
        expected.parameters.jsCode = expected.parameters.jsCode.replace(
          /https:\/\/wa\.me\/\d{8,15}(?=[?#\s'"`]|$)/g,
          'https://wa.me/' + config.ownNumber,
        );
      for (const header of expected.parameters?.headerParameters?.parameters ??
        []) {
        if (header.name === 'X-Silmer-Workflow-Version')
          header.value = 'waha-webjs-1';
      }
      assert.deepEqual(adapted, expected, previous.name);
    }
  }
  assert.equal(result.active, false);
  assert.equal(result.pinData, undefined);
  assert.equal(result.settings.saveDataSuccessExecution, 'none');
  assert.equal(result.settings.saveDataErrorExecution, 'none');
});

test('CHAN-WA-01 / WAHA-01D: site redirect follows ownNumber and preserves query, message, IDs and unrelated links', () => {
  const original = structuredClone(source);
  const name = 'Site - Direcionar para WhatsApp (MVP)';
  const redirect = original.nodes.find(
    (/** @type {any} */ node) => node.name === name,
  );
  redirect.id = 'synthetic-redirect-id';
  redirect.webhookId = 'synthetic-redirect-webhook';
  const query = '?text=Ol%C3%A1%21%20Vim%20pelo%20site.&source=site#chat';
  const before = `return { json: { output: 'Oi! WhatsApp: https://wa.me/5511000000002${query} Outro link: https://example.invalid/5511000000002' } };`;
  redirect.parameters.jsCode = before;
  const other = original.nodes.find(
    (/** @type {any} */ node) =>
      node.name === 'Normalizar comando do painel (MVP)',
  );
  if (other)
    other.parameters.syntheticLink = 'https://wa.me/5511000000002?keep=true';
  const result = createWahaWorkflow(original, config);
  const changed = result.nodes.find(
    (/** @type {any} */ node) => node.name === name,
  );
  assert.deepEqual(changed, {
    ...redirect,
    parameters: {
      ...redirect.parameters,
      jsCode: before.replace(
        'https://wa.me/5511000000002' + query,
        'https://wa.me/' + config.ownNumber + query,
      ),
    },
  });
  assert.equal(redirect.parameters.jsCode, before);
  if (other)
    assert.equal(
      result.nodes.find((/** @type {any} */ node) => node.name === other.name)
        .parameters.syntheticLink,
      other.parameters.syntheticLink,
    );
});

test('CHAN-WA-01: source without optional site redirect remains supported', () => {
  const original = structuredClone(source);
  original.nodes = original.nodes.filter(
    (/** @type {any} */ node) =>
      node.name !== 'Site - Direcionar para WhatsApp (MVP)',
  );
  const result = createWahaWorkflow(original, config);
  assert.equal(
    result.nodes.some(
      (/** @type {any} */ node) =>
        node.name === 'Site - Direcionar para WhatsApp (MVP)',
    ),
    false,
  );
  assert.equal(result.active, false);
});

test('WAHA-01: webhook uses header credential and never Meta OAuth; authenticated conversion is the sole WhatsApp entry', () => {
  const trigger = nodes.get('WhatsApp - Receber eventos (MVP)');
  assert.equal(trigger.type, 'n8n-nodes-base.webhook');
  assert.equal(trigger.parameters.authentication, 'headerAuth');
  assert.equal(trigger.parameters.path, 'silmer/waha-events');
  assert.equal(trigger.parameters.responseMode, 'responseNode');
  assert.equal(trigger.parameters.options.responseCode, undefined);
  assert.deepEqual(trigger.credentials, {
    httpHeaderAuth: {
      id: 'synthetic-hook-credential',
      name: 'Silmer WAHA para n8n',
    },
  });
  assert.deepEqual(targets(trigger.name), ['WAHA - Validar origem (MVP)']);
  assert.deepEqual(targets('WAHA - Montar evento WhatsApp (MVP)'), [
    'Normalizar evento WhatsApp (MVP)',
  ]);
  assert.equal(
    workflow.nodes.some(
      (/** @type {any} */ node) =>
        node.credentials?.whatsAppApi || node.credentials?.whatsAppTriggerApi,
    ),
    false,
  );
});

test('WAHA-01D / ORC-08: durable CRM success acknowledges first without changing journey or status branches', () => {
  const gate = 'WAHA - Filtrar confirmação durável (MVP)';
  const ack = 'WAHA - Confirmar recebimento durável (MVP)';
  assert.equal(workflow.settings.executionOrder, 'v1');
  for (const name of [
    'CRM - Registrar inbound (MVP)',
    'CRM - Registrar status de entrega (MVP)',
  ]) {
    const expected = source.connections[name]?.main?.[0] ?? [];
    assert.equal(targets(name)[0], gate);
    assert.deepEqual(workflow.connections[name].main[0].slice(1), expected);
    assert.ok(
      nodes.get(gate).position[1] <
        Math.min(
          ...expected.map(
            (/** @type {any} */ edge) => nodes.get(edge.node).position[1],
          ),
        ),
    );
  }
  assert.deepEqual(targets(gate), [ack]);
  assert.equal(workflow.connections[ack], undefined);
  assert.equal(nodes.get(ack).type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(nodes.get(ack).parameters.options.responseCode, 202);
  assert.equal(nodes.get(ack).parameters.responseBody, '{"accepted":true}');
  for (const name of [
    'WAHA - Validar origem (MVP)',
    'WAHA - Consultar identidade (MVP)',
    'WAHA - Montar evento WhatsApp (MVP)',
    'CRM - Registrar inbound (MVP)',
    'CRM - Registrar status de entrega (MVP)',
  ]) {
    assert.equal(nodes.get(name).continueOnFail, undefined);
    assert.equal(nodes.get(name).onError, undefined);
  }
});

test('WAHA-01D: site chat bypasses the HTTP ACK branch; ignored WAHA events finish before CRM', async () => {
  const gate = 'WAHA - Filtrar confirmação durável (MVP)';
  const site = await runCode(
    gate,
    { private: 'synthetic-crm-result' },
    { 'Normalizar evento WhatsApp (MVP)': { json: { channel: 'site_chat' } } },
  );
  assert.equal(site.length, 0);
  const whatsapp = await runCode(
    gate,
    { durable: true },
    { 'Normalizar evento WhatsApp (MVP)': { json: { channel: 'whatsapp' } } },
  );
  assert.equal(whatsapp.length, 1);
  for (const skipped of [
    event({ event: 'session.status', me: null }),
    event({ payload: { ...event().payload, fromMe: true } }),
  ]) {
    const ignored = await runCode('WAHA - Validar origem (MVP)', {
      body: skipped,
    });
    assert.equal(ignored.length, 0);
  }
  const unknownLid = event();
  unknownLid.payload.from = '123456789@lid';
  const validated = validateWahaEvent(unknownLid, config);
  await assert.rejects(
    runCode(
      'WAHA - Montar evento WhatsApp (MVP)',
      { lid: unknownLid.payload.from, pn: null },
      { 'WAHA - Validar origem (MVP)': { json: validated } },
    ),
    /WAHA_IDENTITY_UNRESOLVED/u,
  );
  // n8n's documented responseNode semantics: completion without Respond is
  // HTTP 200; a thrown error before the first Respond is HTTP 500. These
  // structural assertions require the real n8n HTTP smoke before cutover.
  assert.equal(
    nodes.get('WhatsApp - Receber eventos (MVP)').parameters.responseMode,
    'responseNode',
  );
});

test('WAHA-01D: existing error handler is preserved; self handler requires known ID and saves no execution bodies', async () => {
  const withId = structuredClone(source);
  withId.id = 'synthetic-persisted-workflow';
  delete withId.settings.errorWorkflow;
  const self = createWahaWorkflow(withId, config);
  assert.equal(self.settings.errorWorkflow, withId.id);
  const configured = structuredClone(withId);
  configured.settings.errorWorkflow = 'synthetic-existing-handler';
  assert.equal(
    createWahaWorkflow(configured, config).settings.errorWorkflow,
    'synthetic-existing-handler',
  );
  assert.equal(workflow.settings.errorWorkflow, source.settings.errorWorkflow);
  assert.deepEqual(
    self.connections['Capturar falha do workflow (MVP)'],
    source.connections['Capturar falha do workflow (MVP)'],
  );
  const body = await runCode('Preparar workflow.failed (MVP)', {
    execution: {
      id: 'synthetic-execution',
      lastNodeExecuted: 'WAHA - Montar evento WhatsApp (MVP)',
      error: {
        message: 'synthetic-private-body-canary',
        stack: 'synthetic-private-stack-canary',
      },
    },
  });
  assert.equal(body.json.payload.conversation_id, null);
  assert.equal(body.json.payload.event_type, 'workflow.failed');
  assert.equal(JSON.stringify(body).includes('canary'), false);
  assert.equal(self.settings.saveDataSuccessExecution, 'none');
  assert.equal(self.settings.saveDataErrorExecution, 'none');
  assert.equal(self.settings.saveManualExecutions, false);
  assert.equal(self.settings.saveExecutionProgress, false);
});

test('WAHA-01: wrong session, engine and own account fail before CRM or identity lookup', () => {
  for (const altered of [
    { session: 'other' },
    { engine: 'NOWEB' },
    { me: { id: '5511000000999@c.us' } },
    { me: {} },
  ]) {
    assert.throws(() => validateWahaEvent(event(altered), config), /MISMATCH/u);
  }
});

test('WAHA-01: echoes, self-chat, groups, broadcasts, newsletters and reactions cannot trigger AI', () => {
  for (const change of [
    { fromMe: true },
    { from: '5511000000000@c.us' },
    { from: '12345@g.us' },
    { from: 'status@broadcast' },
    { from: '1234@newsletter' },
    { participant: '5511000000002@c.us' },
    { isGroup: true },
  ]) {
    const input = event();
    Object.assign(input.payload, change);
    assert.equal(validateWahaEvent(input, config), null);
  }
  assert.equal(
    validateWahaEvent(event({ event: 'message.reaction' }), config),
    null,
  );
});

test('WAHA-01: stable inbound ID, timestamp, verified PN and caption survive the existing normalizer', async () => {
  const input = event();
  const validated = validateWahaEvent({ body: input }, config);
  const meta = convertWahaEvent(validated, null, config);
  const result = await runCode('Normalizar evento WhatsApp (MVP)', meta);
  assert.equal(result.json.from, '5511000000001');
  assert.equal(result.json.event_id, input.payload.id);
  assert.equal(result.json.occurred_at, '2026-10-27T11:20:00.000Z');
  assert.equal(result.json.text, 'Quero dez camisetas');
  assert.equal(result.json.ai_readable, true);
  const repeated = await runCode('Normalizar evento WhatsApp (MVP)', meta);
  assert.deepEqual(
    JSON.parse(JSON.stringify(repeated)),
    JSON.parse(JSON.stringify(result)),
  );
});

test('WAHA-01: LID requires exact authenticated lookup mapping, never interpreted as telephone', () => {
  const input = event();
  input.payload.from = '123456789012345@lid';
  const validated = validateWahaEvent(input, config);
  assert.equal(validated.needs_lid, true);
  for (const mapping of [
    null,
    { lid: input.payload.from, pn: null },
    { lid: 'other@lid', pn: '5511000000001@c.us' },
  ]) {
    assert.throws(
      () => convertWahaEvent(validated, mapping, config),
      /WAHA_IDENTITY_UNRESOLVED/u,
    );
  }
  const result = convertWahaEvent(
    validated,
    { lid: input.payload.from, pn: '5511000000001@c.us' },
    config,
  );
  assert.equal(result.messages[0].from, '5511000000001');
  assert.match(
    nodes.get('WAHA - Consultar identidade (MVP)').parameters.url,
    /encodeURIComponent\(\$json.chat\)/u,
  );
  assert.equal(
    nodes.get('WAHA - Consultar identidade (MVP)').parameters.genericAuthType,
    'httpHeaderAuth',
  );
});

test('WAHA-01D / ORC-08: outgoing ACKs map only device/read/played/failure; synchronous result owns sent', async () => {
  for (const [ack, status] of [
    [2, 'delivered'],
    [3, 'read'],
    [4, 'read'],
    [-1, 'failed'],
  ]) {
    const input = event({ event: 'message.ack' });
    Object.assign(input.payload, { fromMe: true, ack });
    const result = convertWahaEvent(
      validateWahaEvent(input, config),
      null,
      config,
    );
    assert.equal(result.statuses[0].status, status);
    assert.equal(result.statuses[0].id, input.payload.id);
    const normalized = await runCode(
      'Normalizar evento WhatsApp (MVP)',
      result,
    );
    const prepared = await runCode(
      'Preparar status de entrega (MVP)',
      normalized.json,
    );
    assert.notEqual(prepared.json.payload.event_type, 'message.sent');
    assert.equal(prepared.json.payload.event_type, 'message.' + status);
  }
  for (const ack of [0, 1]) {
    const ignored = event({ event: 'message.ack' });
    Object.assign(ignored.payload, { fromMe: true, ack });
    assert.equal(validateWahaEvent(ignored, config), null);
    const filtered = await runCode('WAHA - Validar origem (MVP)', {
      body: ignored,
    });
    assert.equal(filtered.length, 0);
  }
});

test('WAHA-01D / MSG-03: receipt time uses stable envelope milliseconds, not original message timestamp', async () => {
  const input = event({ event: 'message.ack', timestamp: 1793100123456 });
  Object.assign(input.payload, { fromMe: true, ack: 2, timestamp: 1793000000 });
  const converted = convertWahaEvent(
    validateWahaEvent(input, config),
    null,
    config,
  );
  const normalized = await runCode(
    'Normalizar evento WhatsApp (MVP)',
    converted,
  );
  assert.equal(normalized.json.occurred_at, '2026-10-27T11:22:03.000Z');
  const repeated = await runCode('Normalizar evento WhatsApp (MVP)', converted);
  assert.equal(repeated.json.event_id, normalized.json.event_id);
  assert.equal(repeated.json.occurred_at, normalized.json.occurred_at);
  const inbound = event({ timestamp: 1793100123456 });
  assert.equal(
    validateWahaEvent(inbound, config).occurred_at_seconds,
    inbound.payload.timestamp,
  );
  const missingReceiptTime = event({
    event: 'message.ack',
    timestamp: undefined,
  });
  Object.assign(missingReceiptTime.payload, { fromMe: true, ack: 2 });
  assert.throws(
    () => validateWahaEvent(missingReceiptTime, config),
    /WAHA_TIMESTAMP_INVALID/u,
  );
});

test('WAHA-01: credential-bearing media URL rejects other origin, query keys, redirects and traversal', () => {
  const prefix = config.baseUrl + '/api/files/';
  const allowed = prefix + 'default/false_5511000000001@c.us_MESSAGE.jpg';
  assert.equal(validateWahaMediaUrl(allowed, config.baseUrl), allowed);
  for (const url of [
    'https://external.invalid/api/files/file.jpg',
    config.baseUrl + '.attacker.invalid/api/files/file.jpg',
    prefix + '../admin',
    prefix + '%2e%2e/admin',
    prefix + 'file.jpg?x-api-key=secret',
    prefix + 'file.jpg#fragment',
    prefix + 'a\\b.jpg',
    prefix + '%2fetc',
  ]) {
    assert.throws(
      () => validateWahaMediaUrl(url, config.baseUrl),
      /WAHA_MEDIA_URL_INVALID/u,
    );
  }
  const download = nodes.get('WhatsApp - Baixar mídia (MVP)');
  assert.equal(download.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(
    download.parameters.options.redirect.redirect.followRedirects,
    false,
  );
});

test('WAHA-01: image/audio bytes follow existing bounded AI media path, not Meta', async () => {
  for (const mimetype of ['image/png', 'audio/ogg']) {
    const input = event();
    input.payload.hasMedia = true;
    input.payload.media = {
      mimetype,
      url: config.baseUrl + '/api/files/synthetic.png',
    };
    const meta = convertWahaEvent(
      validateWahaEvent(input, config),
      null,
      config,
    );
    const normalized = await runCode('Normalizar evento WhatsApp (MVP)', meta);
    assert.equal(normalized.json.ai_readable, true);
    const result = await runCode(
      'WhatsApp - Consultar mídia (MVP)',
      normalized.json,
      { 'Normalizar evento WhatsApp (MVP)': normalized },
    );
    assert.equal(result.json.url, input.payload.media.url);
  }
});

test('WAHA-01: every text send preserves reservation and routes invalid success or HTTP error to unknown without retry', async () => {
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const send = nodes.get(name);
    assert.equal(send.retryOnFail, false);
    assert.equal(send.parameters.url, config.baseUrl + '/api/sendText');
    assert.equal(
      send.parameters.options.redirect.redirect.followRedirects,
      false,
    );
    const validator = targets(name)[0];
    const prior = source.connections[name].main;
    assert.deepEqual(
      targets(validator),
      prior[0].map((/** @type {any} */ edge) => edge.node),
    );
    assert.deepEqual(
      targets(validator, 1),
      prior[1].map((/** @type {any} */ edge) => edge.node),
    );
    assert.deepEqual(targets(name, 1), targets(validator, 1));
    await assert.rejects(runCode(validator, {}), /WAHA_SEND_OUTCOME_UNKNOWN/u);
    const accepted = await runCode(validator, {
      id: 'true_5511000000001@c.us_SENT',
    });
    assert.equal(accepted.json.messages[0].id, 'true_5511000000001@c.us_SENT');
  }
  for (const name of [
    'CRM - Reservar envio da IA (MVP)',
    'CRM - Reservar envio humano (MVP)',
    'Envio humano autorizado? (MVP)',
    'Envio da IA autorizado? (MVP)',
    'Responder comando aceito (MVP)',
  ]) {
    assert.deepEqual(workflow.connections[name], source.connections[name]);
  }
});

test('WAHA-01: sticker remains a figurinha without an image-model download; boot status is ignored', async () => {
  const input = event();
  input.payload.hasMedia = true;
  input.payload.media = {
    mimetype: 'image/webp',
    url: config.baseUrl + '/api/files/synthetic.webp',
  };
  input.payload._data = { type: 'sticker' };
  const meta = convertWahaEvent(validateWahaEvent(input, config), null, config);
  assert.equal(meta.messages[0].type, 'sticker');
  const normalized = await runCode('Normalizar evento WhatsApp (MVP)', meta);
  assert.equal(normalized.json.text, '[figurinha]');
  assert.equal(normalized.json.media_kind, '');
  assert.equal(normalized.json.media_source, '');
  assert.equal(
    validateWahaEvent(event({ event: 'session.status', me: null }), config),
    null,
  );
});

test('WAHA-01: human media remains private and ordered hash → base64 → CRM preflight → one WAHA send', async () => {
  const name = 'Meta - Upload midia humana (MVP)';
  assert.equal(nodes.get(name).type, 'n8n-nodes-base.code');
  assert.deepEqual(targets(name), ['CRM - Preflight midia reservada (MVP)']);
  const command = {
    to: '+5511000000001',
    message: {
      media_id: 'synthetic-media',
      type: 'image',
      mime_type: 'image/png',
      size_bytes: Buffer.byteLength('synthetic-media'),
      sha256: 'synthetic-hash',
      caption: 'Arte sintética',
    },
  };
  const upstream = {
    'Preparar reserva de envio humano (MVP)': { json: { command } },
  };
  const prepared = await runCode(name, {}, upstream);
  assert.equal(
    prepared.json.file.data,
    Buffer.from('synthetic-media').toString('base64'),
  );
  assert.equal(prepared.json.file.url, undefined);
  const preflight = {
    valid: true,
    media_id: command.message.media_id,
    type: command.message.type,
    mime_type: command.message.mime_type,
    size_bytes: command.message.size_bytes,
    sha256: command.message.sha256,
  };
  const payload = await runCode(
    'Preparar mensagem Meta de midia (MVP)',
    preflight,
    { ...upstream, [name]: prepared },
  );
  assert.equal(payload.json.waha_endpoint, 'sendImage');
  assert.equal(payload.json.waha_message.chatId, '5511000000001@c.us');
  assert.equal(payload.json.waha_message.caption, 'Arte sintética');
  for (const to of [
    '++5511000000001',
    ' 5511000000001',
    '5511-000000001',
    '5511000000001@c.us',
    '123@lid',
    '1234567',
    '1234567890123456',
  ]) {
    await assert.rejects(
      runCode('Preparar mensagem Meta de midia (MVP)', preflight, {
        ...upstream,
        'Preparar reserva de envio humano (MVP)': {
          json: { command: { ...command, to } },
        },
        [name]: prepared,
      }),
      /WAHA_RECIPIENT_INVALID/u,
    );
  }
  await assert.rejects(
    runCode(
      'Preparar mensagem Meta de midia (MVP)',
      { ...preflight, valid: false },
      { ...upstream, [name]: prepared },
    ),
    /MEDIA_PREFLIGHT_REJECTED/u,
  );
  const send = nodes.get('Meta - Enviar midia humana (MVP)');
  assert.equal(send.retryOnFail, false);
  assert.equal(send.parameters.genericAuthType, 'httpHeaderAuth');
  assert.equal(
    JSON.stringify(workflow).includes('https://graph.facebook.com'),
    false,
  );
});

test('WAHA-01D / ORC-05: human command accepts CRM E.164 plus without changing bot recipients or reservation', () => {
  const name = 'WhatsApp - Enviar texto humano (MVP)';
  const expression = nodes
    .get(name)
    .parameters.jsonBody.replace(/^=?\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  const bodyFor = (/** @type {any} */ to) =>
    vm.runInNewContext(expression, {
      $: () => ({
        item: {
          json: { command: { to, message: { text: 'Mensagem sintética' } } },
        },
      }),
    });
  for (const to of ['5511000000001', '+5511000000001']) {
    const body = bodyFor(to);
    assert.equal(body.chatId, '5511000000001@c.us');
    assert.equal(body.text, 'Mensagem sintética');
    assert.equal(body.session, config.session);
  }
  for (const to of [
    '++5511000000001',
    '+ 5511000000001',
    ' 5511000000001',
    '5511-000000001',
    '5511000000001@c.us',
    '123@lid',
    '1234567',
    '1234567890123456',
    '',
  ])
    assert.throws(() => bodyFor(to), /WAHA_RECIPIENT_INVALID/u);
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
  ])
    assert.equal(
      nodes.get(name).parameters.jsonBody.includes('.replace(/^\\+/, '),
      false,
    );
  assert.deepEqual(
    workflow.connections['CRM - Reservar envio humano (MVP)'],
    source.connections['CRM - Reservar envio humano (MVP)'],
  );
});

test('WAHA-01: raw WEBJS MessageId is serialized exactly for text/media delivery correlation', async () => {
  const id = 'true_5511000000001@c.us_SYNTHETIC_SENT';
  const raw = {
    id: {
      fromMe: true,
      remote: '5511000000001@c.us',
      id: 'SYNTHETIC_SENT',
      _serialized: id,
    },
  };
  for (const name of [
    ...targets('WhatsApp - Enviar texto humano (MVP)'),
    'Validar resposta do envio de midia (MVP)',
  ]) {
    const result = await runCode(name, raw);
    assert.equal(result.json.messages[0].id, id);
    await assert.rejects(
      runCode(name, { id: { id: 'INCOMPLETE' } }),
      /WAHA_SEND_OUTCOME_UNKNOWN/u,
    );
  }
});

test('WAHA-01: deployment configuration is required and cannot introduce credentials in base URL', () => {
  assert.throws(
    () => createWahaWorkflow(source, /** @type {any} */ ({})),
    /WAHA_OWN_NUMBER_REQUIRED/u,
  );
  assert.throws(
    () =>
      createWahaWorkflow(source, {
        ...config,
        baseUrl: 'http://user:secret@waha.invalid',
      }),
    /WAHA_BASE_URL_INVALID/u,
  );
  assert.throws(
    () => createWahaWorkflow(workflow, config),
    /WAHA_WORKFLOW_ALREADY_ADAPTED/u,
  );
});
