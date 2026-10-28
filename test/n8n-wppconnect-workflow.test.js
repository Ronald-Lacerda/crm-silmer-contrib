import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  convertWppconnectEvent,
  createWppconnectWorkflow,
  decodeWppconnectMedia,
  getWppconnectMessageId,
  validateWppconnectEvent,
} from '../ops/n8n/workflows/create-wppconnect-workflow.mjs';

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
  session: 'default',
  baseUrl: 'http://schedule_silmer-wppconnect:21465',
  apiCredentialId: 'synthetic-wpp-api',
  webhookCredentialId: 'synthetic-wpp-webhook',
};
for (const node of source.nodes) node.id = 'synthetic:' + node.name;
const workflow = createWppconnectWorkflow(source, config);
const nodes = new Map(
  workflow.nodes.map((/** @type {any} */ node) => [node.name, node]),
);
/** @param {any} [extra] */
function event(extra = {}) {
  return {
    event: 'onmessage',
    session: 'default',
    __wpp_own_jid: config.ownNumber + '@c.us',
    __wpp_received_at: '2026-10-28T12:00:30.123Z',
    id: 'false_5511000000001@c.us_SYNTHETIC',
    type: 'chat',
    body: 'Quero dez camisetas',
    from: '5511000000001@c.us',
    to: config.ownNumber + '@c.us',
    fromMe: false,
    t: 1793188800,
    timestamp: 1793188800,
    isGroupMsg: false,
    ...extra,
  };
}
/** @param {any} [extra] */
function ack(extra = {}) {
  return event({
    event: 'onack',
    id: {
      _serialized: 'true_5511000000001@c.us_SENT',
      remote: '5511000000001@c.us',
      fromMe: true,
    },
    fromMe: undefined,
    from: config.ownNumber + '@c.us',
    to: '5511000000001@c.us',
    ack: 2,
    ...extra,
  });
}
/** @param {string} name @param {number} [output] */
const targets = (name, output = 0) =>
  (workflow.connections[name]?.main?.[output] ?? []).map(
    (/** @type {any} */ item) => item.node,
  );
/** @param {string} name @param {any} json @param {any} [upstream] @param {any} [binary] */
async function runCode(name, json, upstream = {}, binary = {}) {
  return vm.runInNewContext(
    `(async function(){${nodes.get(name).parameters.jsCode}}).call(ctx)`,
    {
      $json: json,
      $: (/** @type {string} */ key) => ({ item: upstream[key] }),
      $input: { item: { json, binary }, all: () => [{ json, binary }] },
      $itemIndex: 0,
      $execution: { id: '42' },
      Buffer,
      ctx: {
        helpers: {
          getBinaryDataBuffer: async () => Buffer.from('synthetic-media'),
        },
      },
    },
  );
}
/** @param {any} expression @param {any} json @param {any} [upstream] */
function evaluate(expression, json, upstream = {}) {
  return vm.runInNewContext(
    expression.replace(/^=?\{\{\s*/, '').replace(/\s*\}\}$/, ''),
    {
      $json: json,
      $: (/** @type {string} */ key) => ({ item: upstream[key] }),
    },
  );
}

test('WPP-01: preserves IDs/journey/site identities and redirects site to configured account without changing query', () => {
  const originalSource = structuredClone(source);
  const redirect = originalSource.nodes.find(
    (/** @type {any} */ node) =>
      node.name === 'Site - Direcionar para WhatsApp (MVP)',
  );
  redirect.webhookId = 'synthetic-site-redirect-webhook';
  redirect.parameters.jsCode =
    "return { json: { output: 'Oi! WhatsApp: https://wa.me/5511000000002?text=Ol%C3%A1%21%20Vim%20pelo%20site.&source=site#chat' } };";
  const before = JSON.stringify(originalSource);
  const result = createWppconnectWorkflow(originalSource, config);
  assert.equal(JSON.stringify(originalSource), before);
  for (const original of originalSource.nodes) {
    const changed = result.nodes.find(
      (/** @type {any} */ node) => node.name === original.name,
    );
    assert.equal(changed.id, original.id, original.name);
    if (
      original.name.startsWith('CRM -') ||
      original.name.startsWith('Site -') ||
      original.name.startsWith('Painel -') ||
      original.name.includes('Reservar envio') ||
      original.name === 'Atendente virtual Silmer (MVP)'
    ) {
      const expected = structuredClone(original);
      if (original.name === redirect.name)
        expected.parameters.jsCode = redirect.parameters.jsCode.replace(
          'https://wa.me/5511000000002?',
          'https://wa.me/' + config.ownNumber + '?',
        );
      for (const header of expected.parameters?.headerParameters?.parameters ??
        [])
        if (header.name === 'X-Silmer-Workflow-Version')
          header.value = 'wppconnect-1';
      assert.deepEqual(changed, expected, original.name);
    }
  }
  assert.equal(result.active, false);
  assert.equal(result.pinData, undefined);
  assert.equal(result.settings.saveDataErrorExecution, 'none');
  assert.equal(result.settings.saveDataSuccessExecution, 'none');
  assert.equal(result.settings.saveManualExecutions, false);
  assert.equal(result.settings.saveExecutionProgress, false);
  assert.equal(JSON.stringify(result).includes('waha'), false);
  assert.equal(JSON.stringify(result).includes('WAHA'), false);
  assert.equal(JSON.stringify(result).includes('graph.facebook.com'), false);
  assert.equal(
    result.nodes.some(
      (/** @type {any} */ node) =>
        node.credentials?.whatsAppApi || node.credentials?.whatsAppTriggerApi,
    ),
    false,
  );
});

test('ORC-01: entry is header authenticated, session-scoped, with responseNode ACK', () => {
  const trigger = nodes.get('WhatsApp - Receber eventos (MVP)');
  assert.equal(trigger.parameters.path, 'silmer/wppconnect-events');
  assert.equal(trigger.parameters.authentication, 'headerAuth');
  assert.equal(trigger.parameters.responseMode, 'responseNode');
  assert.deepEqual(trigger.credentials, {
    httpHeaderAuth: {
      id: config.webhookCredentialId,
      name: 'Silmer WPPConnect para n8n',
    },
  });
  assert.deepEqual(targets(trigger.name), [
    'WPPConnect - Validar origem (MVP)',
  ]);
  assert.deepEqual(targets('WPPConnect - Montar evento WhatsApp (MVP)'), [
    'Normalizar evento WhatsApp (MVP)',
  ]);
  assert.equal(
    nodes
      .get('WPPConnect - Consultar identidade (MVP)')
      .parameters.url.includes('/api/default/contact/pn-lid/'),
    true,
  );
});

test('ORC-08: durable ACK is first after CRM acceptance; original journey edges remain', async () => {
  const gate = 'WPPConnect - Filtrar confirmação durável (MVP)';
  for (const name of [
    'CRM - Registrar inbound (MVP)',
    'CRM - Registrar status de entrega (MVP)',
  ]) {
    assert.equal(targets(name)[0], gate);
    assert.deepEqual(
      workflow.connections[name].main[0].slice(1),
      source.connections[name]?.main?.[0] ?? [],
    );
  }
  assert.deepEqual(targets(gate), [
    'WPPConnect - Confirmar recebimento durável (MVP)',
  ]);
  const respond = nodes.get(targets(gate)[0]);
  assert.equal(respond.type, 'n8n-nodes-base.respondToWebhook');
  assert.equal(respond.parameters.options.responseCode, 202);
  assert.equal(workflow.connections[respond.name], undefined);
  assert.equal(workflow.settings.executionOrder, 'v1');
  assert.equal(
    respond.position[1] <
      Math.min(
        ...source.nodes.map((/** @type {any} */ node) => node.position[1]),
      ),
    true,
  );
  const site = await runCode(
    gate,
    { accepted: true },
    { 'Normalizar evento WhatsApp (MVP)': { json: { channel: 'site_chat' } } },
  );
  assert.equal(site.length, 0);
  const wa = await runCode(
    gate,
    { accepted: true },
    { 'Normalizar evento WhatsApp (MVP)': { json: { channel: 'whatsapp' } } },
  );
  assert.equal(wa.length, 1);
});

test('ORC-08: self ErrorTrigger fallback is explicit only with persisted ID; existing handler preserved', () => {
  const copy = structuredClone(source);
  copy.id = 'synthetic-workflow';
  copy.settings ??= {};
  delete copy.settings.errorWorkflow;
  const generated = createWppconnectWorkflow(copy, config);
  assert.equal(generated.settings.errorWorkflow, copy.id);
  const originalError = source.nodes.find(
    (/** @type {any} */ node) => node.type === 'n8n-nodes-base.errorTrigger',
  );
  assert.deepEqual(
    generated.nodes.find(
      (/** @type {any} */ node) => node.id === originalError.id,
    ),
    originalError,
  );
  copy.settings.errorWorkflow = 'external-sanitized-handler';
  assert.equal(
    createWppconnectWorkflow(copy, config).settings.errorWorkflow,
    'external-sanitized-handler',
  );
});

test('WPP-01: origin requires exact session, real account pin and patched stable timestamp', () => {
  for (const extra of [
    { session: 'other' },
    { __wpp_own_jid: '5511000000002@c.us' },
    { __wpp_own_jid: undefined },
    { __wpp_own_jid: '1234@lid' },
    { __wpp_received_at: undefined },
    { __wpp_received_at: 1793188800000 },
    { __wpp_received_at: 'not-a-date' },
    { to: '5511000000002@c.us' },
  ])
    assert.throws(
      () => validateWppconnectEvent(event(extra), config),
      /WPP_(?:SOURCE|ACCOUNT|RECEIPT_TIMESTAMP|DESTINATION)_/u,
    );
  assert.equal(
    validateWppconnectEvent(
      event({ __wpp_own_jid: config.ownNumber + '@s.whatsapp.net' }),
      config,
    ).needs_lid,
    false,
  );
  assert.equal(
    validateWppconnectEvent({ body: event() }, config).chat,
    '5511000000001@c.us',
  );
});

test('WPP-01: self/group/status/newsletter/history/notification events are ignored', async () => {
  for (const extra of [
    { fromMe: true },
    { isGroupMsg: true },
    { broadcast: true },
    { author: '5511000000002@c.us' },
    { from: 'status@broadcast' },
    { from: '123@newsletter' },
    { isMdHistoryMsg: true },
    { isNotification: true },
    { event: 'onselfmessage' },
    { event: 'status-find', __wpp_own_jid: null },
    { event: 'qrcode', __wpp_received_at: null },
  ])
    assert.equal(
      validateWppconnectEvent(event(extra), config),
      null,
      JSON.stringify(extra),
    );
  const filtered = await runCode(
    'WPPConnect - Validar origem (MVP)',
    event({ isGroupMsg: true }),
  );
  assert.equal(filtered.length, 0);
  await assert.rejects(
    runCode('WPPConnect - Validar origem (MVP)', event({ session: 'other' })),
    /WPP_SOURCE_MISMATCH/u,
  );
});

test('ORC-05: strict full message IDs bind the direct chat, never an inferred phone', () => {
  for (const extra of [
    { id: 'token-only' },
    { id: { id: 'token-only' } },
    { id: 'false_5511000000002@c.us_OTHER' },
    { id: 'false_5511000000001@c.us_BAD\nID' },
  ])
    assert.throws(
      () => validateWppconnectEvent(event(extra), config),
      /WPP_MESSAGE_(?:ID|CHAT)_/u,
    );
  assert.equal(
    validateWppconnectEvent(
      event({ id: 'false_123@g.us_GROUP', from: '123@g.us' }),
      config,
    ),
    null,
  );
});

test('INB-01: text, reply and customer name retain exact external ID without raw account/address data', async () => {
  const input = validateWppconnectEvent(
    event({
      quotedMsgId: 'true_5511000000001@c.us_QUOTED',
      notifyName: 'Cliente sintético',
      mediaKey: 'NEVER_COPY',
      sender: { pushname: 'Alias', phonebook: 'NEVER_COPY' },
    }),
    config,
  );
  assert.equal(JSON.stringify(input).includes('NEVER_COPY'), false);
  const converted = convertWppconnectEvent(input, null, config);
  assert.equal(converted.messages[0].id, event().id);
  assert.equal(converted.messages[0].text.body, event().body);
  assert.equal(
    converted.messages[0].context.id,
    'true_5511000000001@c.us_QUOTED',
  );
  const normalized = await runCode(
    'Normalizar evento WhatsApp (MVP)',
    converted,
  );
  assert.equal(normalized.json.from, '5511000000001');
  assert.equal(normalized.json.event_id, event().id);
  assert.equal(normalized.json.channel, 'whatsapp');
  assert.equal(normalized.json.ai_readable, true);
});

test('ORC-05/MSG-03: ACK1 ignored; delivery uses stable receipt time rather than old message t', () => {
  for (const state of [0, 1, 5, '2', null])
    assert.equal(validateWppconnectEvent(ack({ ack: state }), config), null);
  for (const [state, status] of [
    [-1, 'failed'],
    [2, 'delivered'],
    [3, 'read'],
    [4, 'read'],
  ]) {
    const checked = validateWppconnectEvent(
      ack({ ack: state, timestamp: 1600000000, t: 1600000000 }),
      config,
    );
    const a = convertWppconnectEvent(checked, null, config);
    const b = convertWppconnectEvent(
      validateWppconnectEvent(
        ack({ ack: state, timestamp: 1600000000, t: 1600000000 }),
        config,
      ),
      null,
      config,
    );
    assert.deepEqual(a, b);
    assert.equal(a.statuses[0].status, status);
    assert.equal(
      a.statuses[0].timestamp,
      String(Math.floor(Date.parse(ack().__wpp_received_at) / 1000)),
    );
    assert.equal(a.statuses[0].id, ack().id._serialized);
  }
  assert.equal(validateWppconnectEvent(ack({ fromMe: false }), config), null);
  assert.throws(
    () =>
      validateWppconnectEvent(ack({ __wpp_received_at: undefined }), config),
    /WPP_RECEIPT_TIMESTAMP_INVALID/u,
  );
  const withWid = ack();
  withWid.id.remote = { _serialized: '5511000000001@c.us' };
  assert.equal(
    validateWppconnectEvent(withWid, config).chat,
    '5511000000001@c.us',
  );
  withWid.id.remote = { _serialized: '5511000000002@c.us' };
  assert.throws(
    () => validateWppconnectEvent(withWid, config),
    /WPP_MESSAGE_CHAT_MISMATCH/u,
  );
});

test('WPP-01: LID mapping requires exactly requested serialized LID and verified provider PN', () => {
  const checked = validateWppconnectEvent(
    event({ id: 'false_123456789012345@lid_LID', from: '123456789012345@lid' }),
    config,
  );
  assert.equal(checked.needs_lid, true);
  const mapping = {
    lid: { id: '123456789012345', server: 'lid', _serialized: checked.chat },
    phoneNumber: {
      id: '5511000000001',
      server: 'c.us',
      _serialized: '5511000000001@c.us',
    },
  };
  assert.equal(
    convertWppconnectEvent(checked, mapping, config).messages[0].from,
    '5511000000001',
  );
  for (const invalid of [
    null,
    {},
    { lid: checked.chat, pn: '5511000000001@c.us' },
    { ...mapping, lid: { _serialized: '999@lid' } },
    { ...mapping, phoneNumber: { id: '5511000000001' } },
    { ...mapping, phoneNumber: { _serialized: config.ownNumber + '@c.us' } },
  ])
    assert.throws(
      () => convertWppconnectEvent(checked, invalid, config),
      /WPP_IDENTITY_UNRESOLVED/u,
    );
});

test('MSG-02: media metadata preserves image/audio/video/document; sticker never enters model media path', async () => {
  for (const [kind, mime, expected] of [
    ['image', 'image/png', 'image'],
    ['ptt', 'audio/ogg; codecs=opus', 'audio'],
    ['video', 'video/mp4', 'video'],
    ['document', 'application/pdf', 'document'],
    ['sticker', 'image/webp', 'sticker'],
  ]) {
    const converted = convertWppconnectEvent(
      validateWppconnectEvent(
        event({
          type: kind,
          mimetype: mime,
          body: 'NEVER_BASE64',
          caption: 'Arte sintética',
          filename: 'arte.pdf',
          isMedia: true,
          clientUrl: 'https://untrusted.invalid',
        }),
        config,
      ),
      null,
      config,
    );
    assert.equal(converted.messages[0].type, expected);
    assert.equal(converted.messages[0][expected].caption, 'Arte sintética');
    assert.equal(JSON.stringify(converted).includes('NEVER_BASE64'), false);
    assert.equal(
      JSON.stringify(converted).includes('untrusted.invalid'),
      false,
    );
    const normalized = await runCode(
      'Normalizar evento WhatsApp (MVP)',
      converted,
    );
    if (kind === 'sticker') {
      assert.equal(normalized.json.media_kind, '');
      assert.equal(normalized.json.text, '[figurinha]');
    }
    if (kind === 'image' || kind === 'ptt')
      assert.equal(normalized.json.media_source, 'whatsapp');
  }
});

test('WPP-01: contact/location/unsupported content remains visible without inventing identity', async () => {
  for (const [extra, part] of [
    [{ type: 'vcard', body: 'BEGIN:VCARD' }, 'Contato compartilhado'],
    [
      { type: 'location', lat: -20, lng: -40, loc: 'Local sintético' },
      'Localização enviada',
    ],
    [
      { type: 'poll_creation', body: 'ignored' },
      'Mensagem do tipo unsupported',
    ],
  ]) {
    const converted = convertWppconnectEvent(
      validateWppconnectEvent(event(extra), config),
      null,
      config,
    );
    const normalized = await runCode(
      'Normalizar evento WhatsApp (MVP)',
      converted,
    );
    assert.equal(normalized.json.text.includes(part), true);
  }
});

test('MSG-02: inbound bytes fetched only by authenticated fixed session/id; strict MIME/base64/size', async () => {
  const query = nodes.get('WhatsApp - Consultar mídia (MVP)');
  assert.equal(query.parameters.method, 'GET');
  assert.equal(query.credentials.httpHeaderAuth.id, config.apiCredentialId);
  assert.equal(
    query.parameters.options.redirect.redirect.followRedirects,
    false,
  );
  const normalized = {
    media_id: 'false_5511000000001@c.us_SYNTHETIC',
    media_kind: 'image',
    media_mime_type: 'image/png',
  };
  assert.equal(
    evaluate(
      query.parameters.url,
      {},
      { 'Normalizar evento WhatsApp (MVP)': { json: normalized } },
    ),
    config.baseUrl +
      '/api/default/get-media-by-message/' +
      encodeURIComponent(normalized.media_id),
  );
  const raw = {
    base64: Buffer.from('synthetic-media').toString('base64'),
    mimetype: 'image/png',
  };
  const result = decodeWppconnectMedia(raw, normalized);
  assert.equal(result.binary.data.data, raw.base64);
  const inCode = await runCode('WhatsApp - Baixar mídia (MVP)', raw, {
    'Normalizar evento WhatsApp (MVP)': { json: normalized },
  });
  assert.equal(inCode.binary.data.mimeType, 'image/png');
  for (const invalid of [
    { ...raw, base64: 'file:///secret' },
    { ...raw, base64: 'data:image/png;base64,YQ==' },
    { ...raw, base64: 'YQ=' },
    { ...raw, base64: 'YR==' },
    { ...raw, mimetype: 'image/svg+xml' },
    { ...raw, mimetype: 'audio/ogg' },
    { ...raw, base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
  ])
    assert.throws(
      () => decodeWppconnectMedia(invalid, normalized),
      /WPP_MEDIA_INVALID/u,
    );
});

test('ORC-05: each text send has one provider call after original reservation and no retries', async () => {
  const id = 'true_5511000000001@c.us_SENT';
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const send = nodes.get(name);
    assert.equal(
      send.parameters.url,
      config.baseUrl + '/api/default/send-message',
    );
    assert.equal(send.retryOnFail, false);
    assert.equal(send.onError, 'continueErrorOutput');
    assert.equal(send.credentials.httpHeaderAuth.id, config.apiCredentialId);
    const validator = targets(name)[0];
    const result = await runCode(validator, {
      status: 'success',
      response: [{ id }],
    });
    assert.equal(result.json.messages[0].id, id);
    await assert.rejects(
      runCode(validator, { status: 'success', response: [{}] }),
      /WPP_SEND_OUTCOME_UNKNOWN/u,
    );
    assert.deepEqual(
      targets(validator),
      source.connections[name].main[0].map(
        (/** @type {any} */ edge) => edge.node,
      ),
    );
    assert.deepEqual(
      targets(validator, 1),
      source.connections[name].main[1].map(
        (/** @type {any} */ edge) => edge.node,
      ),
    );
    assert.deepEqual(
      targets(name, 1),
      source.connections[name].main[1].map(
        (/** @type {any} */ edge) => edge.node,
      ),
    );
  }
  for (const original of source.nodes.filter((/** @type {any} */ node) =>
    node.name.includes('Reservar envio'),
  )) {
    assert.deepEqual(
      workflow.connections[original.name],
      source.connections[original.name],
    );
  }
});

test('WPP-01: text payload binds one direct recipient and cannot expand to a bulk/group send', () => {
  const cases = [
    [
      'WhatsApp - Enviar aviso de transferência (MVP)',
      {
        'Preparar aviso de transferência (MVP)': {
          json: { wa_id: '5511000000001', text: 'Aviso sintético' },
        },
      },
    ],
    [
      'WhatsApp - Enviar resposta da IA (MVP)',
      {
        'Normalizar evento WhatsApp (MVP)': { json: { from: '5511000000001' } },
        'Normalizar decisão da IA (MVP)': {
          json: { reply_text: 'Resposta sintética' },
        },
      },
    ],
    [
      'WhatsApp - Enviar texto humano (MVP)',
      {
        'Preparar reserva de envio humano (MVP)': {
          json: {
            command: {
              to: '+5511000000001',
              message: { text: 'Texto sintético' },
            },
          },
        },
      },
    ],
  ];
  for (const [name, upstream] of cases) {
    const body = evaluate(nodes.get(name).parameters.jsonBody, {}, upstream);
    assert.equal(body.phone, '5511000000001@c.us');
    assert.equal(body.isGroup, false);
    assert.equal(body.isNewsletter, false);
    assert.equal(body.isLid, false);
    assert.equal(body.options.linkPreview, false);
    assert.equal(typeof body.message, 'string');
  }
  const expression = nodes.get('WhatsApp - Enviar texto humano (MVP)')
    .parameters.jsonBody;
  for (const to of [
    '5511000000001,5511000000002',
    '123@g.us',
    '123@lid',
    '++5511000000001',
    '+ 5511000000001',
    '5511-000000001',
    '5511000000001@c.us',
    '1234567',
    '1234567890123456',
    '',
    null,
  ])
    assert.throws(
      () =>
        evaluate(
          expression,
          {},
          {
            'Preparar reserva de envio humano (MVP)': {
              json: { command: { to, message: { text: 'x' } } },
            },
          },
        ),
      /WPP_RECIPIENT_INVALID/u,
    );
});

test('ORC-08: exactly one full serialized send result, never retry on malformed 2xx', () => {
  const id = 'true_5511000000001@c.us_SENT';
  assert.equal(
    getWppconnectMessageId({ status: 'success', response: [{ id }] }),
    id,
  );
  assert.equal(
    getWppconnectMessageId({
      status: 'success',
      response: [{ id: { _serialized: id } }],
    }),
    id,
  );
  for (const response of [
    { id },
    { status: 'error', response: [{ id }] },
    { status: 'success', response: [] },
    { status: 'success', response: [{ id }, { id }] },
    { status: 'success', response: [{ id: { id: 'SHORT' } }] },
    { status: 'success', response: [{ id, ack: -1 }] },
    { status: 'success', response: [{ id, erro: true }] },
    {
      status: 'success',
      response: [{ id: 'false_5511000000001@c.us_INBOUND' }],
    },
  ])
    assert.throws(
      () => getWppconnectMessageId(response),
      /WPP_SEND_OUTCOME_UNKNOWN/u,
    );
});

test('MSG-02/ORC-05: media remains reserve → hash → local data URI → CRM preflight → one send', async () => {
  for (const type of ['image', 'audio', 'video']) {
    const command = {
      to: '+5511000000001',
      message: {
        media_id: 'synthetic-media',
        type,
        mime_type:
          type === 'image'
            ? 'image/png'
            : type === 'audio'
              ? 'audio/ogg'
              : 'video/mp4',
        size_bytes: Buffer.byteLength('synthetic-media'),
        sha256: 'synthetic-hash',
        caption: 'Arte sintética',
      },
    };
    const upstream = {
      'Preparar reserva de envio humano (MVP)': { json: { command } },
    };
    const prepared = await runCode(
      'Meta - Upload midia humana (MVP)',
      {},
      upstream,
    );
    const preflight = { valid: true, ...command.message };
    const payload = await runCode(
      'Preparar mensagem Meta de midia (MVP)',
      preflight,
      { ...upstream, 'Meta - Upload midia humana (MVP)': prepared },
    );
    assert.equal(
      payload.json.wpp_endpoint,
      type === 'audio' ? 'send-voice-base64' : 'send-file-base64',
    );
    assert.equal(payload.json.wpp_message.phone, '5511000000001@c.us');
    assert.equal(payload.json.wpp_message.path, undefined);
    for (const to of [
      '++5511000000001',
      ' 5511000000001',
      '5511-000000001',
      '5511000000001@c.us',
      '123@lid',
      '1234567',
      '1234567890123456',
    ])
      await assert.rejects(
        runCode('Preparar mensagem Meta de midia (MVP)', preflight, {
          ...upstream,
          'Preparar reserva de envio humano (MVP)': {
            json: { command: { ...command, to } },
          },
          'Meta - Upload midia humana (MVP)': prepared,
        }),
        /WPP_RECIPIENT_INVALID/u,
      );
    assert.equal(
      payload.json.wpp_message.base64 ?? payload.json.wpp_message.base64Ptt,
      'data:' +
        command.message.mime_type +
        ';base64,' +
        Buffer.from('synthetic-media').toString('base64'),
    );
    await assert.rejects(
      runCode(
        'Preparar mensagem Meta de midia (MVP)',
        { ...preflight, valid: false },
        { ...upstream, 'Meta - Upload midia humana (MVP)': prepared },
      ),
      /MEDIA_PREFLIGHT_REJECTED/u,
    );
    const send = nodes.get('Meta - Enviar midia humana (MVP)');
    assert.equal(send.retryOnFail, false);
    assert.equal(send.onError, 'continueErrorOutput');
    assert.equal(
      evaluate(send.parameters.url, payload.json),
      config.baseUrl + '/api/default/' + payload.json.wpp_endpoint,
    );
  }
  for (const name of [
    'Meta - Upload midia humana (MVP)',
    'CRM - Preflight midia reservada (MVP)',
    'Preparar mensagem Meta de midia (MVP)',
    'Meta - Enviar midia humana (MVP)',
    'Medir bytes da midia (MVP)',
    'Calcular SHA256 da midia (MVP)',
  ])
    if (source.connections[name])
      assert.deepEqual(
        workflow.connections[name],
        source.connections[name],
        name,
      );
  await assert.rejects(
    runCode(
      'Meta - Upload midia humana (MVP)',
      {},
      {
        'Preparar reserva de envio humano (MVP)': {
          json: { command: { message: { size_bytes: 999 } } },
        },
      },
    ),
    /MEDIA_INTEGRITY_MISMATCH/u,
  );
});

test('WPP-01: configuration prevents credentials in URLs, invalid session and double adaptation', () => {
  assert.throws(
    () => createWppconnectWorkflow(source, /** @type {any} */ ({})),
    /OWN_NUMBER_REQUIRED/u,
  );
  for (const baseUrl of [
    'http://user:secret@host',
    'http://host/path',
    'http://host/?token=secret',
    'file:///etc/passwd',
  ])
    assert.throws(
      () => createWppconnectWorkflow(source, { ...config, baseUrl }),
      /BASE_URL_INVALID/u,
    );
  assert.throws(
    () => createWppconnectWorkflow(source, { ...config, session: '../other' }),
    /SESSION_INVALID/u,
  );
  assert.throws(
    () => createWppconnectWorkflow(workflow, config),
    /WPP_WORKFLOW_ALREADY_ADAPTED/u,
  );
  const defaults = createWppconnectWorkflow(source, {
    ownNumber: config.ownNumber,
  });
  assert.equal(
    defaults.nodes.find(
      (/** @type {any} */ node) =>
        node.name === 'WhatsApp - Enviar texto humano (MVP)',
    ).parameters.url,
    config.baseUrl + '/api/default/send-message',
  );
});
