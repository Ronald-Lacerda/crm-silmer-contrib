import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeInboxImage,
  patchEvolutionInboundImages,
} from '../ops/n8n/patch-evolution-inbound-images.mjs';

const prefix = 'Inbox - Imagem recebida - ';
/** @returns {Record<string, any>} */
function fixture() {
  const result = /** @type {Record<string, any>} */ ({
    id: 'synthetic-workflow',
    settings: { executionOrder: 'v1' },
    nodes: [
      {
        name: prefix + 'Filtrar',
        type: 'n8n-nodes-base.if',
        position: [100, 900],
        parameters: {
          conditions: {
            conditions: [
              {
                leftValue:
                  "={{ (() => { const n = $('Normalizar evento WhatsApp (MVP)').item.json; return n.channel === 'whatsapp' && n.message_type === 'audio'; })() }}",
                operator: { type: 'boolean', operation: 'true' },
              },
            ],
          },
        },
      },
      {
        name: prefix + 'Consultar URL',
        type: 'n8n-nodes-base.httpRequest',
        position: [300, 900],
        credentials: { httpHeaderAuth: { id: 'synthetic-credential' } },
        parameters: {
          url: 'http://gateway:8080/chat/getBase64FromMediaMessage/synthetic',
          jsonBody: '={{ ({ message: { key: { id: $json.id } } }) }}',
        },
      },
      {
        name: prefix + 'Baixar',
        type: 'n8n-nodes-base.code',
        position: [500, 900],
        parameters: {
          mode: 'runOnceForEachItem',
          jsCode:
            'const decodeEvolutionMedia = response => ({json:{preservedAudio:true,response}}); return decodeEvolutionMedia($json);',
        },
      },
      {
        name: prefix + 'Medir',
        type: 'n8n-nodes-base.code',
        position: [700, 900],
        parameters: {
          jsCode:
            "const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }; const bytes = await this.helpers.getBinaryDataBuffer($itemIndex, 'data'); if(bytes.length>5*1024*1024)throw Error();",
        },
      },
      {
        name: prefix + 'Registrar falha',
        type: 'n8n-nodes-base.httpRequest',
        position: [900, 1000],
        parameters: { url: 'https://crm.invalid/events' },
        credentials: { httpBasicAuth: { id: 'synthetic-crm' } },
      },
      {
        name: 'Commercial route',
        position: [500, 64],
        parameters: { mode: 'preserve' },
      },
      {
        name: 'Durable receipt',
        position: [200, 256],
        parameters: { mode: 'preserve' },
      },
    ],
    connections: {
      'CRM - Registrar inbound (MVP)': {
        main: [
          [
            { node: 'Commercial route', type: 'main', index: 0 },
            { node: prefix + 'Filtrar', type: 'main', index: 0 },
            { node: 'Durable receipt', type: 'main', index: 0 },
          ],
        ],
      },
    },
  });
  for (const name of [
    'SHA256',
    'Preparar anexo',
    'Salvar no CRM',
    'Preparar falha',
  ])
    result.nodes.push({
      name: prefix + name,
      type: 'n8n-nodes-base.code',
      position: [1000, 900],
      parameters: {},
    });
  const chain = [
    'Filtrar',
    'Consultar URL',
    'Baixar',
    'Medir',
    'SHA256',
    'Preparar anexo',
    'Salvar no CRM',
  ];
  for (let i = 0; i < chain.length; i++) {
    const n = result.nodes.find(
      (/** @type {any} */ n) => n.name === prefix + chain[i],
    );
    const outputs =
      i < chain.length - 1
        ? [[{ node: prefix + chain[i + 1], type: 'main', index: 0 }]]
        : [[]];
    if (i) {
      n.onError = 'continueErrorOutput';
      outputs.push([
        { node: prefix + 'Preparar falha', type: 'main', index: 0 },
      ]);
    }
    result.connections[prefix + chain[i]] = { main: outputs };
  }
  result.connections[prefix + 'Preparar falha'] = {
    main: [[{ node: prefix + 'Registrar falha', type: 'main', index: 0 }]],
  };
  return result;
}

test('IMG-03/04: patch preserves commercial nodes, credentials, edges and IDs, and schedules images first', () => {
  const source = fixture(),
    before = structuredClone(source),
    patched = patchEvolutionInboundImages(source);
  assert.deepEqual(source, before);
  assert.deepEqual(patched.connections, source.connections);
  assert.deepEqual(patched.settings, source.settings);
  assert.equal(patched.id, source.id);
  assert.equal(patched.nodes.length, source.nodes.length);
  for (let i = 0; i < source.nodes.length; i++) {
    assert.equal(patched.nodes[i].name, source.nodes[i].name);
    assert.deepEqual(patched.nodes[i].credentials, source.nodes[i].credentials);
    if (['Commercial route', 'Durable receipt'].includes(source.nodes[i].name))
      assert.deepEqual(patched.nodes[i], source.nodes[i]);
  }
  const ordered = patched.connections['CRM - Registrar inbound (MVP)'].main[0]
    .map((/** @type {any} */ e) =>
      patched.nodes.find((/** @type {any} */ n) => n.name === e.node),
    )
    .sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        a.position[1] - b.position[1] || a.position[0] - b.position[0],
    );
  assert.equal(ordered[0].name, prefix + 'Filtrar');
  assert.equal(
    patched.nodes.find(
      (/** @type {any} */ n) => n.name === prefix + 'Registrar falha',
    ).onError,
    'continueRegularOutput',
  );
});

test('IMG-04: filter accepts image documents/GIF without treating arbitrary documents as images', () => {
  const patched = patchEvolutionInboundImages(fixture());
  const expression =
    patched.nodes[0].parameters.conditions.conditions[0].leftValue;
  assert.equal(expression.indexOf('}}'), expression.length - 2);
  const evaluate = new Function('$', `return ${expression.slice(3, -2)};`);
  for (const message_type of ['image', 'document'])
    for (const media_mime_type of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]) {
      assert.equal(
        evaluate(() => ({
          item: {
            json: { channel: 'whatsapp', message_type, media_mime_type },
          },
        })),
        true,
      );
    }
  for (const source of [
    { channel: 'site', message_type: 'image', media_mime_type: 'image/png' },
    {
      channel: 'whatsapp',
      message_type: 'document',
      media_mime_type: 'application/pdf',
    },
    {
      channel: 'whatsapp',
      message_type: 'sticker',
      media_mime_type: 'image/webp',
    },
  ])
    assert.equal(
      evaluate(() => ({ item: { json: source } })),
      false,
    );
});

test('IMG-04: actual generated decoder handles every image/document type and preserves bytes', () => {
  const code = patchEvolutionInboundImages(fixture()).nodes.find(
    (/** @type {any} */ n) => n.name === prefix + 'Baixar',
  ).parameters.jsCode;
  const decode = new Function('$json', '$', code);
  const audio = { mimetype: 'audio/ogg', base64: 'U1lOVEhFVElD' };
  assert.deepEqual(
    decode(audio, () => ({ item: { json: { message_type: 'audio' } } })),
    { json: { preservedAudio: true, response: audio } },
  );
  const bytes = Buffer.from(
    'synthetic bytes checked by API content detector and scanner',
  );
  for (const message_type of ['image', 'document'])
    for (const mimetype of [
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/gif',
    ]) {
      const response = { mimetype, base64: bytes.toString('base64') };
      const result = decode(response, () => ({
        item: { json: { message_type, media_mime_type: mimetype } },
      }));
      assert.deepEqual(Buffer.from(result.binary.data.data, 'base64'), bytes);
      assert.equal(result.binary.data.mimeType, mimetype);
    }
});

test('IMG-02/04: decoder rejects URL-only, mismatched MIME, oversized/noncanonical/empty data', () => {
  const source = { message_type: 'document', media_mime_type: 'image/gif' };
  const good = {
    mimetype: 'image/gif',
    base64: Buffer.from('GIF89a').toString('base64'),
  };
  assert.ok(decodeInboxImage(good, source));
  for (const bad of [
    { url: 'https://untrusted.invalid/image' },
    { ...good, mimetype: 'application/pdf' },
    { ...good, base64: '' },
    { ...good, base64: '!!!!' },
    { ...good, base64: 'Zh==' },
    { ...good, base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
  ])
    assert.throws(() => decodeInboxImage(bad, source), /INBOUND_IMAGE_INVALID/);
  assert.throws(() =>
    decodeInboxImage(good, { ...source, message_type: 'text' }),
  );
});

test('IMG-03: patch fails closed for a stale or unexpected workflow', () => {
  const bad = [];
  let x = fixture();
  x.settings.executionOrder = 'v0';
  bad.push(x);
  x = fixture();
  x.nodes[1].credentials = {};
  bad.push(x);
  x = fixture();
  x.nodes[2].parameters.jsCode = 'unexpected';
  bad.push(x);
  x = fixture();
  x.connections = {};
  bad.push(x);
  for (const source of bad)
    assert.throws(() => patchEvolutionInboundImages(source));
});
