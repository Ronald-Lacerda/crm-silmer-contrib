import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { patchWahaInboundImages } from '../ops/n8n/patch-waha-inbound-images.mjs';
import { createWahaWorkflow } from '../ops/n8n/workflows/create-waha-workflow.mjs';
import {
  convertEvolutionEvent,
  createEvolutionWorkflow,
  decodeEvolutionMedia,
  getEvolutionMessageId,
  restoreEvolutionTransportSource,
  validateEvolutionEvent,
} from '../ops/n8n/workflows/create-evolution-workflow.mjs';

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
  session: 'silmer',
  baseUrl: 'http://schedule_silmer-evolution:8080',
  apiCredentialId: 'synthetic-evolution-api',
  webhookCredentialId: 'synthetic-evolution-webhook',
};
for (const node of source.nodes) node.id = 'synthetic:' + node.name;
const before = JSON.stringify(source);

/** The complete persisted-image branch, rather than two stand-in provider nodes. */
function persistedImageWorkflow() {
  const current = createWahaWorkflow(source, {
    ownNumber: config.ownNumber,
    apiCredentialId: 'synthetic-old-api',
    webhookCredentialId: 'synthetic-old-hook',
  });
  const inbound = current.nodes.find(
    (/** @type {any} */ node) => node.name === 'CRM - Registrar inbound (MVP)',
  );
  inbound.parameters.url =
    'https://crm.invalid/api/v1/integrations/n8n/messages/inbound';
  inbound.credentials = { httpBasicAuth: { id: 'synthetic-crm', name: 'CRM' } };
  const patched = patchWahaInboundImages(current).workflow;
  const result = createEvolutionWorkflow(patched, {
    ...config,
    transportBaseline: source,
  });
  return { patched, result };
}

const workflow = createEvolutionWorkflow(source, config);
const nodes = new Map(
  workflow.nodes.map((/** @type {any} */ node) => [node.name, node]),
);
/** @param {any} [extra] */
function event(extra = {}) {
  return {
    event: 'messages.upsert',
    instance: 'silmer',
    sender: config.ownNumber + '@s.whatsapp.net',
    date_time: '2026-10-29T12:00:30.123Z',
    data: {
      key: {
        id: 'SYNTHETIC_INBOUND',
        fromMe: false,
        remoteJid: '5511000000001@s.whatsapp.net',
      },
      message: { conversation: 'Quero dez camisetas' },
      messageType: 'conversation',
      messageTimestamp: 1793275200,
      pushName: 'Cliente sintético',
    },
    ...extra,
  };
}
/** @param {any} [extra] */
function ack(extra = {}) {
  return event({
    event: 'messages.update',
    data: {
      keyId: 'SYNTHETIC_SENT',
      fromMe: true,
      remoteJid: '5511000000001@s.whatsapp.net',
      status: 'DELIVERY_ACK',
      ...extra,
    },
  });
}
/** @param {string} name @param {number} [output] */
const targets = (name, output = 0) =>
  (workflow.connections[name]?.main?.[output] ?? []).map(
    (/** @type {any} */ edge) => edge.node,
  );
/** @param {string} name @param {any} json @param {any} [upstream] */
async function runCode(name, json, upstream = {}) {
  return vm.runInNewContext(
    `(async function(){${nodes.get(name).parameters.jsCode}}).call(ctx)`,
    {
      $json: json,
      $: (/** @type {string} */ key) => ({ item: upstream[key] }),
      $input: { item: { json }, all: () => [{ json }] },
      $itemIndex: 0,
      Buffer,
      ctx: {
        helpers: {
          getBinaryDataBuffer: async () => Buffer.from('synthetic-media'),
        },
      },
    },
  );
}
/** @param {string} expr @param {any} json @param {any} [upstream] */
function evaluate(expr, json, upstream = {}) {
  return vm.runInNewContext(
    '(' + expr.replace(/^=?\{\{\s*/, '').replace(/\s*\}\}$/, '') + ')',
    {
      $json: json,
      $: (/** @type {string} */ key) => ({ item: upstream[key] }),
    },
  );
}

test('EVOL-01: source Meta immutable; candidate inactive and contains only Evolution transport', () => {
  assert.equal(JSON.stringify(source), before);
  assert.equal(workflow.active, false);
  assert.equal(workflow.id, undefined);
  assert.equal(workflow.settings.errorWorkflow, undefined);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.saveDataErrorExecution, 'none');
  assert.equal(workflow.settings.saveManualExecutions, false);
  assert.equal(workflow.settings.saveExecutionProgress, false);
  const raw = JSON.stringify(workflow);
  for (const forbidden of [
    'WAHA',
    'waha',
    'WPPConnect',
    'wppconnect',
    'graph.facebook.com',
  ])
    assert.equal(raw.includes(forbidden), false, forbidden);
  for (const original of source.nodes) {
    const name = original.name
      .replace(
        'Meta - Upload midia humana',
        'Evolution - Preparar bytes humanos',
      )
      .replace(
        'Preparar mensagem Meta de midia',
        'Preparar mensagem Evolution de midia',
      )
      .replace('Meta - Enviar midia humana', 'Evolution - Enviar midia humana');
    const changed = nodes.get(name);
    assert.equal(changed.id, original.id, name);
    if (
      original.name.startsWith('CRM -') ||
      original.name.startsWith('Painel -') ||
      original.name.includes('Reservar envio') ||
      original.name === 'Atendente virtual Silmer (MVP)'
    ) {
      const expected = structuredClone(original);
      for (const header of expected.parameters?.headerParameters?.parameters ??
        [])
        if (header.name === 'X-Silmer-Workflow-Version')
          header.value = 'evolution-baileys-1';
      assert.deepEqual(changed, expected, name);
    }
  }
  const explicit = createEvolutionWorkflow(source, {
    ...config,
    workflowId: 'synthetic-evolution',
  });
  assert.equal(explicit.id, 'synthetic-evolution');
  assert.equal(explicit.settings.errorWorkflow, 'synthetic-evolution');
});

test('ORC-08: webhook authenticates via credential; ACK follows durable CRM acceptance', () => {
  const trigger = nodes.get('WhatsApp - Receber eventos (MVP)');
  assert.equal(trigger.parameters.path, 'silmer/evolution-events');
  assert.equal(trigger.parameters.authentication, 'headerAuth');
  assert.equal(trigger.parameters.responseMode, 'responseNode');
  assert.equal(
    trigger.credentials.httpHeaderAuth.id,
    config.webhookCredentialId,
  );
  assert.deepEqual(targets(trigger.name), ['Evolution - Validar origem (MVP)']);
  for (const name of [
    'CRM - Registrar inbound (MVP)',
    'CRM - Registrar status de entrega (MVP)',
  ])
    assert.equal(
      targets(name)[0],
      'Evolution - Filtrar confirmação durável (MVP)',
    );
  assert.deepEqual(targets('Evolution - Filtrar confirmação durável (MVP)'), [
    'Evolution - Confirmar recebimento durável (MVP)',
  ]);
  assert.equal(
    nodes.get('Evolution - Confirmar recebimento durável (MVP)').parameters
      .options.responseCode,
    202,
  );
});

test('EVOL-01: wrong account/instance and malformed receipt fail closed without exposing payload', () => {
  for (const [extra, error] of [
    [{ instance: 'other' }, /EVOLUTION_SOURCE_MISMATCH/u],
    [{ sender: '5511000000002@s.whatsapp.net' }, /EVOLUTION_ACCOUNT_MISMATCH/u],
    [{ sender: '5511000000000@lid' }, /EVOLUTION_ACCOUNT_MISMATCH/u],
    [{ date_time: null }, /EVOLUTION_RECEIPT_TIMESTAMP_INVALID/u],
    [
      { date_time: '2026-02-31T12:00:00.000Z' },
      /EVOLUTION_RECEIPT_TIMESTAMP_INVALID/u,
    ],
    [{ data: [] }, /EVOLUTION_PAYLOAD_INVALID/u],
  ])
    assert.throws(() => validateEvolutionEvent(event(extra), config), error);
  const raw = event({ apikey: 'NEVER_COPY', destination: 'NEVER_COPY' });
  raw.data.messageKey = 'NEVER_COPY';
  raw.data.message.thumbnail = 'NEVER_COPY';
  assert.equal(
    JSON.stringify(validateEvolutionEvent(raw, config)).includes('NEVER_COPY'),
    false,
  );
});

test('INB-01: inbound text/name/reply normalize into unchanged CRM contract', async () => {
  const raw = event();
  raw.data.contextInfo = {
    stanzaId: 'SYNTHETIC_QUOTED',
    quotedMessage: { conversation: 'NEVER_COPY' },
  };
  const checked = validateEvolutionEvent({ body: raw }, config);
  const converted = convertEvolutionEvent(checked, null, config);
  assert.equal(converted.messages[0].from, '5511000000001');
  assert.equal(converted.messages[0].context.id, 'SYNTHETIC_QUOTED');
  assert.equal(converted.contacts[0].profile.name, 'Cliente sintético');
  const normalized = await runCode(
    'Normalizar evento WhatsApp (MVP)',
    converted,
  );
  assert.equal(normalized.json.event_id, 'SYNTHETIC_INBOUND');
  assert.equal(normalized.json.from, '5511000000001');
  assert.equal(normalized.json.channel, 'whatsapp');
  assert.equal(normalized.json.ai_readable, true);
});

test('EVOL-01: echoes/groups/newsletters/status/history/QR do not start automation', async () => {
  for (const key of [
    { fromMe: true },
    { participant: '5511000000002@s.whatsapp.net' },
    { remoteJid: '123@g.us' },
    { remoteJid: 'status@broadcast' },
    { remoteJid: '123@newsletter' },
    { remoteJid: config.ownNumber + '@s.whatsapp.net' },
  ]) {
    const raw = event();
    Object.assign(raw.data.key, key);
    assert.equal(validateEvolutionEvent(raw, config), null);
  }
  for (const kind of [
    'messages.set',
    'send.message',
    'qrcode.updated',
    'contacts.upsert',
  ])
    assert.equal(
      validateEvolutionEvent(event({ event: kind, sender: undefined }), config),
      null,
    );
  assert.equal(
    (
      await runCode(
        'Evolution - Validar origem (MVP)',
        event({ event: 'messages.set' }),
      )
    ).length,
    0,
  );
});

test('MSG-03: status uses stable envelope receipt time, SERVER_ACK not second send', () => {
  for (const state of ['PENDING', 'SERVER_ACK', 'DELETED', 'unknown'])
    assert.equal(validateEvolutionEvent(ack({ status: state }), config), null);
  for (const [state, expected] of [
    ['ERROR', 'failed'],
    ['DELIVERY_ACK', 'delivered'],
    ['READ', 'read'],
    ['PLAYED', 'read'],
  ]) {
    const checked = validateEvolutionEvent(
      ack({ status: state, messageTimestamp: 1600000000 }),
      config,
    );
    const first = convertEvolutionEvent(checked, null, config);
    const replay = convertEvolutionEvent(
      validateEvolutionEvent(ack({ status: state }), config),
      null,
      config,
    );
    assert.deepEqual(first, replay);
    assert.equal(first.statuses[0].status, expected);
    assert.equal(first.statuses[0].id, 'SYNTHETIC_SENT');
    assert.equal(
      first.statuses[0].timestamp,
      String(Math.floor(Date.parse(event().date_time) / 1000)),
    );
  }
  assert.equal(validateEvolutionEvent(ack({ fromMe: false }), config), null);
});

test('ORC-05: LID requires exact same-key provider binding; digits alone are never phone', () => {
  const raw = event();
  raw.data.key.remoteJid = '123456789012345@lid';
  const checked = validateEvolutionEvent(raw, config);
  assert.equal(checked.needs_lid, true);
  const record = {
    key: { ...raw.data.key, remoteJidAlt: '5511000000001@s.whatsapp.net' },
  };
  const mapping = { messages: { records: [record] } };
  assert.equal(
    convertEvolutionEvent(checked, mapping, config).messages[0].from,
    '5511000000001',
  );
  for (const records of [
    [],
    [record, record],
    [{ key: { ...record.key, id: 'OTHER' } }],
    [{ key: { ...record.key, fromMe: true } }],
    [{ key: { ...record.key, remoteJid: '999@lid' } }],
    [
      {
        key: {
          ...record.key,
          remoteJidAlt: config.ownNumber + '@s.whatsapp.net',
        },
      },
    ],
  ])
    assert.throws(
      () => convertEvolutionEvent(checked, { messages: { records } }, config),
      /EVOLUTION_IDENTITY_UNRESOLVED/u,
    );
  raw.data.key.remoteJidAlt = '5511000000001@s.whatsapp.net';
  const bound = validateEvolutionEvent(raw, config);
  assert.equal(bound.needs_lid, false);
  assert.equal(
    convertEvolutionEvent(bound, null, config).messages[0].from,
    '5511000000001',
  );
});

test('OPS-INBOX-ACK-05: a LID receipt correlates only to one exact stored outbound message', () => {
  for (const [status, expected] of [
    ['ERROR', 'failed'],
    ['DELIVERY_ACK', 'delivered'],
    ['READ', 'read'],
    ['PLAYED', 'read'],
  ]) {
    const checked = validateEvolutionEvent(
      ack({ remoteJid: '123456@lid', status }),
      config,
    );
    assert.equal(checked.needs_lid, true);
    const record = {
      key: {
        id: checked.id,
        fromMe: true,
        remoteJid: '5511000000001@s.whatsapp.net',
      },
      status: 'PENDING',
    };
    const mapping = { messages: { records: [record] } };
    const before = JSON.stringify({ checked, mapping });
    const converted = convertEvolutionEvent(checked, mapping, config);
    assert.deepEqual(converted, {
      metadata: { phone_number_id: config.ownNumber },
      statuses: [
        {
          id: checked.id,
          status: expected,
          recipient_id: '5511000000001',
          timestamp: String(checked.occurred_at_seconds),
        },
      ],
    });
    assert.equal('messages' in converted, false);
    assert.equal('contacts' in converted, false);
    assert.equal(JSON.stringify({ checked, mapping }), before);
    for (const key of [
      { ...record.key, remoteJidAlt: checked.chat },
      {
        ...record.key,
        remoteJid: checked.chat,
        remoteJidAlt: record.key.remoteJid,
      },
    ])
      assert.deepEqual(
        convertEvolutionEvent(
          checked,
          { messages: { records: [{ key }] } },
          config,
        ),
        converted,
      );
  }
});

test('OPS-INBOX-ACK-05: duplicate IDs, wrong direction and contradictory or malformed ACK bindings fail closed', () => {
  const checked = validateEvolutionEvent(
    ack({ remoteJid: '123456@lid' }),
    config,
  );
  const record = {
    key: {
      id: checked.id,
      fromMe: true,
      remoteJid: '5511000000001@s.whatsapp.net',
    },
  };
  for (const records of [
    [],
    [null],
    [{}],
    [{ key: null }],
    [record, record],
    [record, { key: { ...record.key, fromMe: false } }],
    [record, { key: { ...record.key, remoteJid: '999@lid' } }],
    [{ key: { ...record.key, id: 'WRONG_MESSAGE' } }],
    [{ key: { ...record.key, fromMe: false } }],
    [{ key: { ...record.key, fromMe: 'true' } }],
    [
      {
        key: { ...record.key, remoteJid: config.ownNumber + '@s.whatsapp.net' },
      },
    ],
    [{ key: { ...record.key, remoteJid: '123@g.us' } }],
    [{ key: { ...record.key, remoteJid: '123456@lid' } }],
    [{ key: { ...record.key, remoteJidAlt: '999999@lid' } }],
    [{ key: { ...record.key, remoteJidAlt: '123@g.us' } }],
    [{ key: { ...record.key, remoteJidAlt: '5511000000002@s.whatsapp.net' } }],
  ])
    assert.throws(
      () => convertEvolutionEvent(checked, { messages: { records } }, config),
      /EVOLUTION_IDENTITY_UNRESOLVED/u,
    );
});

test('OPS-INBOX-ACK-05: the ACK correlation exception never creates an inbound phone binding', () => {
  const raw = event();
  raw.data.key.remoteJid = '123456@lid';
  const checked = validateEvolutionEvent(raw, config);
  for (const records of [
    [null],
    [{ key: null }],
    [
      {
        key: {
          id: checked.id,
          fromMe: false,
          remoteJid: '5511000000001@s.whatsapp.net',
        },
      },
    ],
    [
      {
        key: {
          id: checked.id,
          fromMe: false,
          remoteJid: '5511000000001@s.whatsapp.net',
          remoteJidAlt: checked.chat,
        },
      },
    ],
  ])
    assert.throws(
      () => convertEvolutionEvent(checked, { messages: { records } }, config),
      /EVOLUTION_IDENTITY_UNRESOLVED/u,
    );
});

test('MSG-02: image/audio/video/document metadata keeps provider ID and drops raw media secrets', async () => {
  for (const [type, mime] of [
    ['image', 'image/png'],
    ['audio', 'audio/ogg; codecs=opus'],
    ['video', 'video/mp4'],
    ['document', 'application/pdf'],
    ['sticker', 'image/webp'],
  ]) {
    const raw = event();
    raw.data.message = {
      [type + 'Message']: {
        mimetype: mime,
        caption: 'Arte sintética',
        fileName: 'arte.pdf',
        mediaKey: 'NEVER_COPY',
        url: 'https://untrusted.invalid',
      },
    };
    const checked = validateEvolutionEvent(raw, config);
    assert.equal(JSON.stringify(checked).includes('NEVER_COPY'), false);
    assert.equal(JSON.stringify(checked).includes('untrusted.invalid'), false);
    const converted = convertEvolutionEvent(checked, null, config);
    assert.equal(converted.messages[0][type].id, 'SYNTHETIC_INBOUND');
    const normalized = await runCode(
      'Normalizar evento WhatsApp (MVP)',
      converted,
    );
    if (type === 'image' || type === 'audio')
      assert.equal(normalized.json.media_source, 'whatsapp');
    if (type === 'sticker') assert.equal(normalized.json.media_kind, '');
  }
});

test('EVOL-01/IMG-04: lookup JSON bodies survive n8n template boundaries before JavaScript evaluation', () => {
  // Tournament's ExpressionSplitter terminates code at the first unescaped
  // double close brace; unlike our general VM helper, it does not balance JS
  // object braces. These generated bodies contain no escapes or mixed text.
  // https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/tournament/src/ExpressionSplitter.ts
  /** @param {string} value */
  function templateBody(value) {
    assert.ok(value.startsWith('={{'));
    const end = value.indexOf('}}', 3);
    assert.equal(end, value.length - 2, 'template must close only at its end');
    return value.slice(3, end);
  }
  const mediaBody = nodes.get('WhatsApp - Consultar mídia (MVP)').parameters
    .jsonBody;
  const identityBody = nodes.get('Evolution - Consultar identidade (MVP)')
    .parameters.jsonBody;
  const context = {
    id: 'SYNTHETIC_LID_MESSAGE',
    chat: '123456@lid',
  };
  /** @param {string} name */
  const upstream = (name) => {
    assert.equal(name, 'Normalizar evento WhatsApp (MVP)');
    return { item: { json: { media_id: 'SYNTHETIC_MEDIA' } } };
  };
  const persisted = persistedImageWorkflow().result;
  const clonedBody = persisted.nodes.find(
    (/** @type {any} */ node) =>
      node.name === 'Inbox - Imagem recebida - Consultar URL',
  ).parameters.jsonBody;
  assert.equal(clonedBody, mediaBody);
  for (const body of [mediaBody, clonedBody]) {
    const media = new Function('$json', '$', `return ${templateBody(body)};`)(
      context,
      upstream,
    );
    assert.deepEqual(media, {
      message: { key: { id: 'SYNTHETIC_MEDIA' } },
      convertToMp4: false,
    });
  }
  const identity = new Function(
    '$json',
    '$',
    `return ${templateBody(identityBody)};`,
  )(context, upstream);
  assert.deepEqual(identity, {
    where: { key: { id: context.id, remoteJid: context.chat } },
    offset: 2,
    page: 1,
  });
  const ackIdentity = new Function(
    '$json',
    '$',
    `return ${templateBody(identityBody)};`,
  )({ ...context, event: { kind: 'ack' } }, upstream);
  assert.deepEqual(ackIdentity, {
    where: { key: { id: context.id, fromMe: true } },
    offset: 2,
    page: 1,
  });
  for (const broken of [
    "={{ {message:{key:{id:$('Normalizar evento WhatsApp (MVP)').item.json.media_id}},convertToMp4:false} }}",
    '={{ {where:{key:{id:$json.id,remoteJid:$json.chat}},offset:2,page:1} }}',
  ]) {
    assert.throws(
      () => templateBody(broken),
      /template must close only at its end/u,
    );
    const truncated = broken.slice(3, broken.indexOf('}}', 3));
    assert.throws(
      () => new Function('$json', '$', `return (${truncated});`),
      SyntaxError,
    );
  }
});

test('MSG-02: download by authenticated stored key; no remote URL or embedded key accepted', async () => {
  const query = nodes.get('WhatsApp - Consultar mídia (MVP)');
  assert.equal(query.parameters.method, 'POST');
  assert.equal(
    query.parameters.url,
    config.baseUrl + '/chat/getBase64FromMediaMessage/silmer',
  );
  assert.equal(query.credentials.httpHeaderAuth.id, config.apiCredentialId);
  assert.equal(
    query.parameters.options.redirect.redirect.followRedirects,
    false,
  );
  const normalized = {
    media_id: 'SYNTHETIC_MEDIA',
    media_kind: 'image',
    media_mime_type: 'image/png',
  };
  const body = evaluate(
    query.parameters.jsonBody,
    {},
    { 'Normalizar evento WhatsApp (MVP)': { json: normalized } },
  );
  assert.equal(body.message.key.id, 'SYNTHETIC_MEDIA');
  assert.equal(body.message.message, undefined);
  assert.equal(body.convertToMp4, false);
  const raw = {
    base64: Buffer.from('synthetic-media').toString('base64'),
    mimetype: 'image/png',
  };
  assert.equal(
    decodeEvolutionMedia(raw, normalized).binary.data.data,
    raw.base64,
  );
  const result = await runCode('WhatsApp - Baixar mídia (MVP)', raw, {
    'Normalizar evento WhatsApp (MVP)': { json: normalized },
  });
  assert.equal(result.binary.data.mimeType, 'image/png');
  for (const invalid of [
    { ...raw, base64: 'file:///secret' },
    { ...raw, base64: 'YR==' },
    { ...raw, base64: 'data:image/png;base64,YQ==' },
    { ...raw, mimetype: 'image/svg+xml' },
    { ...raw, mimetype: 'audio/ogg' },
    { ...raw, base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
  ])
    assert.throws(
      () => decodeEvolutionMedia(invalid, normalized),
      /EVOLUTION_MEDIA_INVALID/u,
    );
});

test('ORC-05/08: reserved text sends keep both unknown branches and never retry', async () => {
  for (const name of [
    'WhatsApp - Enviar aviso de transferência (MVP)',
    'WhatsApp - Enviar resposta da IA (MVP)',
    'WhatsApp - Enviar texto humano (MVP)',
  ]) {
    const send = nodes.get(name);
    assert.equal(
      send.parameters.url,
      config.baseUrl + '/message/sendText/silmer',
    );
    assert.equal(send.retryOnFail, false);
    assert.equal(send.onError, 'continueErrorOutput');
    const validator = targets(name)[0];
    const result = await runCode(validator, {
      key: {
        id: 'SYNTHETIC_SENT',
        fromMe: true,
        remoteJid: '5511000000001@s.whatsapp.net',
      },
    });
    assert.equal(result.json.messages[0].id, 'SYNTHETIC_SENT');
    await assert.rejects(
      runCode(validator, { key: { id: 'SYNTHETIC_SENT' } }),
      /EVOLUTION_SEND_OUTCOME_UNKNOWN/u,
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
  ))
    assert.deepEqual(
      workflow.connections[original.name],
      source.connections[original.name],
    );
});

test('EVOL-01: text recipient is one canonical phone, never group/LID/bulk', () => {
  const expr = nodes.get('WhatsApp - Enviar texto humano (MVP)').parameters
    .jsonBody;
  const upstream = (/** @type {any} */ to) => ({
    'Preparar reserva de envio humano (MVP)': {
      json: { command: { to, message: { text: 'Sintético' } } },
    },
  });
  const valid = evaluate(expr, {}, upstream('+5511000000001'));
  assert.equal(valid.number, '5511000000001');
  assert.equal(valid.text, 'Sintético');
  assert.equal(valid.linkPreview, false);
  for (const to of [
    '5511000000001,5511000000002',
    '123@g.us',
    '123@lid',
    '++5511000000001',
    '5511-000000001',
    '+ 5511000000001',
    '',
    null,
  ])
    assert.throws(
      () => evaluate(expr, {}, upstream(to)),
      /EVOLUTION_RECIPIENT_INVALID/u,
    );
});

test('ORC-08: malformed successful provider response remains outcome unknown', () => {
  const valid = {
    key: {
      id: 'SYNTHETIC_SENT',
      fromMe: true,
      remoteJid: '5511000000001@s.whatsapp.net',
    },
    status: 'PENDING',
  };
  assert.equal(getEvolutionMessageId(valid), 'SYNTHETIC_SENT');
  for (const response of [
    {},
    { ...valid, status: 'ERROR' },
    { key: { ...valid.key, fromMe: false } },
    { key: { ...valid.key, id: 'bad id' } },
    { key: { ...valid.key, remoteJid: '123@g.us' } },
  ])
    assert.throws(
      () => getEvolutionMessageId(response),
      /EVOLUTION_SEND_OUTCOME_UNKNOWN/u,
    );
});

test('MSG-02: media follows original reserve/hash/preflight sequence, base64 only, one send', async () => {
  for (const type of ['image', 'audio', 'video']) {
    const command = {
      to: '+5511000000001',
      message: {
        type,
        media_id: 'synthetic-media',
        sha256: 'synthetic-hash',
        size_bytes: Buffer.byteLength('synthetic-media'),
        mime_type:
          type === 'image'
            ? 'image/png'
            : type === 'audio'
              ? 'audio/ogg'
              : 'video/mp4',
        caption: 'Sintético',
      },
    };
    const upstream = {
      'Preparar reserva de envio humano (MVP)': { json: { command } },
    };
    const prepared = await runCode(
      'Evolution - Preparar bytes humanos (MVP)',
      {},
      upstream,
    );
    const preflight = { valid: true, ...command.message };
    const context = {
      ...upstream,
      'Evolution - Preparar bytes humanos (MVP)': prepared,
    };
    const payload = await runCode(
      'Preparar mensagem Evolution de midia (MVP)',
      preflight,
      context,
    );
    assert.equal(
      payload.json.evolution_endpoint,
      type === 'audio' ? 'sendWhatsAppAudio' : 'sendMedia',
    );
    assert.equal(payload.json.evolution_message.number, '5511000000001');
    assert.equal(
      payload.json.evolution_message.media ??
        payload.json.evolution_message.audio,
      Buffer.from('synthetic-media').toString('base64'),
    );
    await assert.rejects(
      runCode(
        'Preparar mensagem Evolution de midia (MVP)',
        { ...preflight, valid: false },
        context,
      ),
      /MEDIA_PREFLIGHT_REJECTED/u,
    );
    const send = nodes.get('Evolution - Enviar midia humana (MVP)');
    assert.equal(send.retryOnFail, false);
    assert.equal(send.onError, 'continueErrorOutput');
    assert.equal(
      evaluate(send.parameters.url, payload.json),
      config.baseUrl +
        '/message/' +
        payload.json.evolution_endpoint +
        '/silmer',
    );
  }
});

test('EVOL-01: invalid config and adapting an already adapted workflow fail closed', () => {
  assert.throws(
    () => createEvolutionWorkflow(source, /** @type {any} */ ({})),
    /OWN_NUMBER_REQUIRED/u,
  );
  for (const baseUrl of [
    'http://user:secret@host',
    'http://host/path',
    'http://host/?token=secret',
    'file:///etc/passwd',
  ])
    assert.throws(
      () => createEvolutionWorkflow(source, { ...config, baseUrl }),
      /BASE_URL_INVALID/u,
    );
  assert.throws(
    () => createEvolutionWorkflow(source, { ...config, session: '../other' }),
    /SESSION_INVALID/u,
  );
  assert.throws(
    () => createEvolutionWorkflow(workflow, config),
    /EVOLUTION_WORKFLOW_ALREADY_ADAPTED/u,
  );
});

test('IMG-01/03/04: complete Evolution image branch preserves bytes, digest and replay identity in human mode', async () => {
  const { patched, result } = persistedImageWorkflow();
  const prefix = 'Inbox - Imagem recebida - ';
  const byName = new Map(
    result.nodes.map((/** @type {any} */ node) => [node.name, node]),
  );
  const raw = event();
  raw.data.message = { imageMessage: { mimetype: 'image/png' } };
  const normalized = await runCode(
    'Normalizar evento WhatsApp (MVP)',
    convertEvolutionEvent(validateEvolutionEvent(raw, config), null, config),
  );
  /** @type {Record<string,any>} */
  const upstream = { 'Normalizar evento WhatsApp (MVP)': normalized };
  const bytes = await readFile('test/fixtures/media-composer.png');
  /** @param {string} name @param {any} item */
  async function execute(name, item) {
    return vm.runInNewContext(
      `(async function(){${byName.get(prefix + name).parameters.jsCode}}).call(ctx)`,
      {
        $json: item.json,
        $input: { item },
        $itemIndex: 0,
        $execution: { id: '42' },
        $: (/** @type {string} */ key) => ({ item: upstream[key] }),
        Buffer,
        ctx: {
          helpers: {
            async getBinaryDataBuffer() {
              return Buffer.from(item.binary.data.data, 'base64');
            },
          },
        },
      },
    );
  }
  const query = byName.get(prefix + 'Consultar URL');
  assert.equal(query.credentials.httpHeaderAuth.id, config.apiCredentialId);
  assert.equal(
    query.parameters.options.redirect.redirect.followRedirects,
    false,
  );
  assert.equal(
    evaluate(query.parameters.jsonBody, {}, upstream).message.key.id,
    raw.data.key.id,
  );
  const downloaded = await execute('Baixar', {
    json: { mimetype: 'image/png', base64: bytes.toString('base64') },
  });
  assert.deepEqual(Buffer.from(downloaded.binary.data.data, 'base64'), bytes);
  const measured = await execute('Medir', downloaded);
  upstream[prefix + 'Medir'] = measured;
  assert.equal(measured.json.mime_type, 'image/png');
  assert.equal(measured.json.filename, 'imagem.png');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(byName.get(prefix + 'SHA256').parameters, {
    action: 'hash',
    type: 'SHA256',
    binaryData: true,
    binaryPropertyName: 'data',
    encoding: 'hex',
    dataPropertyName: 'media_sha256',
  });
  const upload = byName.get(prefix + 'Salvar no CRM');
  for (const duplicate of [false, true]) {
    upstream['CRM - Registrar inbound (MVP)'] = {
      json: {
        conversation_id: 'conversation-synthetic',
        mode: 'human',
        duplicate,
      },
    };
    const filter = byName.get(prefix + 'Filtrar').parameters.conditions
      .conditions[0];
    assert.equal(evaluate(filter.leftValue, {}, upstream), true);
    // n8n Crypto may omit binary: Preparar must retrieve the measured original.
    const prepared = await execute('Preparar anexo', {
      json: { media_sha256: digest },
    });
    assert.deepEqual(Buffer.from(prepared.binary.data.data, 'base64'), bytes);
    assert.equal(prepared.json.content_sha256, digest);
    assert.equal(prepared.json.external_id, raw.data.key.id);
    assert.equal(prepared.json.idempotency_key, raw.data.key.id);
    assert.equal(prepared.json.conversation_id, 'conversation-synthetic');
    assert.equal(
      evaluate(upload.parameters.url, prepared.json, upstream),
      'https://crm.invalid/api/v1/integrations/n8n/conversations/conversation-synthetic/attachments',
    );
  }
  for (const node of patched.nodes.filter(
    (/** @type {any} */ node) =>
      node.name.startsWith(prefix) &&
      !['Consultar URL', 'Baixar'].some((name) => node.name === prefix + name),
  )) {
    const expected = structuredClone(node);
    for (const header of expected.parameters.headerParameters?.parameters ?? [])
      if (header.name === 'X-Silmer-Workflow-Version')
        header.value = 'evolution-baileys-1';
    assert.deepEqual(byName.get(node.name), expected);
  }
  for (const [name, connection] of Object.entries(patched.connections))
    if (name.startsWith(prefix))
      assert.deepEqual(result.connections[name], connection);
  const reached = new Set();
  const pending = [prefix + 'Filtrar'];
  while (pending.length) {
    const name = pending.pop();
    if (!name) continue;
    if (reached.has(name)) continue;
    reached.add(name);
    assert.ok(name.startsWith(prefix), name);
    for (const output of result.connections[name]?.main ?? [])
      for (const edge of output) pending.push(edge.node);
  }
  assert.equal(reached.size, 9);
  for (const invalid of [
    { mimetype: 'image/png', base64: '' },
    { mimetype: 'text/html', base64: bytes.toString('base64') },
  ])
    await assert.rejects(
      execute('Baixar', { json: invalid }),
      /EVOLUTION_MEDIA_INVALID/u,
    );
  const failed = await execute('Preparar falha', {
    json: { error: 'PRIVATE_PROVIDER_DETAIL' },
  });
  assert.equal(failed.json.payload.failure.code, 'INBOUND_MEDIA_STORE_FAILED');
  assert.equal(
    JSON.stringify(failed).includes('PRIVATE_PROVIDER_DETAIL'),
    false,
  );
});

test('EVOL-01: latest WAHA graph is restored narrowly using Meta transport baseline; late domain/Inbox image changes survive', () => {
  const current = createWahaWorkflow(source, {
    ownNumber: config.ownNumber,
    apiCredentialId: 'synthetic-old-api',
    webhookCredentialId: 'synthetic-old-hook',
  });
  const journey = current.nodes.find(
    (/** @type {any} */ node) => node.name === 'Atendente virtual Silmer (MVP)',
  );
  journey.parameters.latestDomain = 'commercial-improvement-after-cutover';
  journey.notes = 'Current domain note must survive';
  current.nodes.push({
    id: 'late-note',
    name: 'Nota atual de domínio',
    type: 'n8n-nodes-base.stickyNote',
    parameters: { content: 'Current journey explanation' },
    position: [0, 0],
  });
  for (const [name, original] of [
    [
      'Inbox - Imagem recebida - Consultar URL',
      'WhatsApp - Consultar mídia (MVP)',
    ],
    ['Inbox - Imagem recebida - Baixar', 'WhatsApp - Baixar mídia (MVP)'],
  ]) {
    const copy = structuredClone(
      current.nodes.find((/** @type {any} */ node) => node.name === original),
    );
    copy.id = 'late:' + name;
    copy.name = name;
    copy.onError = 'continueErrorOutput';
    current.nodes.push(copy);
  }
  current.connections['CRM - Registrar inbound (MVP)'].main[0].push({
    node: 'Inbox - Imagem recebida - Consultar URL',
    type: 'main',
    index: 0,
  });
  current.connections['Inbox - Imagem recebida - Consultar URL'] = {
    main: [
      [{ node: 'Inbox - Imagem recebida - Baixar', type: 'main', index: 0 }],
    ],
  };
  const immutableCurrent = JSON.stringify(current);
  const restored = restoreEvolutionTransportSource(current, source);
  assert.equal(restored.nodes.length, current.nodes.length - 9);
  assert.deepEqual(
    restored.nodes.find(
      (/** @type {any} */ node) => node.name === journey.name,
    ),
    journey,
  );
  assert.equal(JSON.stringify(current), immutableCurrent);
  assert.equal(JSON.stringify(source), before);
  const result = createEvolutionWorkflow(current, {
    ...config,
    transportBaseline: source,
  });
  const all = new Map(
    result.nodes.map((/** @type {any} */ node) => [node.name, node]),
  );
  // OPS-INBOX-SEND-06 adds seven recipient-check/failure nodes after the reserve.
  assert.equal(result.nodes.length, current.nodes.length + 7);
  assert.equal(
    all.get(journey.name).parameters.latestDomain,
    journey.parameters.latestDomain,
  );
  assert.equal(all.get(journey.name).notes, journey.notes);
  assert.deepEqual(
    all.get('Nota atual de domínio'),
    current.nodes.find(
      (/** @type {any} */ node) => node.name === 'Nota atual de domínio',
    ),
  );
  assert.equal(
    all.get('Inbox - Imagem recebida - Consultar URL').id,
    'late:Inbox - Imagem recebida - Consultar URL',
  );
  assert.equal(
    all.get('Inbox - Imagem recebida - Consultar URL').parameters.url,
    config.baseUrl + '/chat/getBase64FromMediaMessage/silmer',
  );
  assert.equal(
    all.get('Inbox - Imagem recebida - Baixar').type,
    'n8n-nodes-base.code',
  );
  assert.equal(
    all.get('Inbox - Imagem recebida - Baixar').credentials,
    undefined,
  );
  assert.deepEqual(
    result.connections['Inbox - Imagem recebida - Consultar URL'],
    current.connections['Inbox - Imagem recebida - Consultar URL'],
  );
  assert.equal(
    result.connections['CRM - Registrar inbound (MVP)'].main[0].some(
      (/** @type {any} */ edge) =>
        edge.node === 'Inbox - Imagem recebida - Consultar URL',
    ),
    true,
  );
  const names = new Set(
    result.nodes.map((/** @type {any} */ node) => node.name),
  );
  for (const [name, kinds] of Object.entries(result.connections)) {
    assert.equal(names.has(name), true, name);
    for (const outputs of Object.values(/** @type {any} */ (kinds)))
      for (const edges of /** @type {any[][]} */ (outputs))
        for (const edge of edges)
          assert.equal(names.has(edge.node), true, edge.node);
  }
  const raw = JSON.stringify(result);
  for (const forbidden of [
    'WAHA',
    'waha',
    'WPPConnect',
    'wppconnect',
    'graph.facebook.com',
  ])
    assert.equal(raw.includes(forbidden), false, forbidden);
  assert.throws(
    () => createEvolutionWorkflow(current, config),
    /EVOLUTION_TRANSPORT_BASELINE_REQUIRED/u,
  );
  const invalid = structuredClone(current);
  delete invalid.connections['WAHA - Validar envio texto humano (MVP)'];
  assert.throws(
    () =>
      createEvolutionWorkflow(invalid, {
        ...config,
        transportBaseline: source,
      }),
    /EVOLUTION_WAHA_SEND_SHAPE_INVALID/u,
  );
});
