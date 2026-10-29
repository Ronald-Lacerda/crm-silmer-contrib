import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { patchEvolutionInboundAudio } from '../ops/n8n/patch-evolution-inbound-audio.mjs';
import { patchWahaInboundImages } from '../ops/n8n/patch-waha-inbound-images.mjs';
import { createWahaWorkflow } from '../ops/n8n/workflows/create-waha-workflow.mjs';
import {
  convertEvolutionEvent,
  createEvolutionWorkflow,
  validateEvolutionEvent,
} from '../ops/n8n/workflows/create-evolution-workflow.mjs';

const NORMALIZE = 'Normalizar evento WhatsApp (MVP)';
const INBOUND = 'CRM - Registrar inbound (MVP)';
const PREFIX = 'Inbox - Imagem recebida - ';
const config = {
  ownNumber: '5511000000000',
  apiCredentialId: 'synthetic-api',
  webhookCredentialId: 'synthetic-hook',
};
const meta = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
/** @returns {any} */
function fixture() {
  const waha = createWahaWorkflow(meta, config);
  const inbound = waha.nodes.find(
    (/** @type {any} */ node) => node.name === INBOUND,
  );
  inbound.parameters.url =
    'https://crm.invalid/api/v1/integrations/n8n/messages/inbound';
  inbound.credentials = { httpBasicAuth: { id: 'synthetic-crm', name: 'CRM' } };
  const source = createEvolutionWorkflow(
    patchWahaInboundImages(waha).workflow,
    { ...config, transportBaseline: meta },
  );
  source.id = 'synthetic-living-workflow';
  source.active = true;
  source.activeVersionId = 'synthetic-published';
  return source;
}
/** @param {any} workflow @param {string} name */
const node = (workflow, name) =>
  workflow.nodes.find((/** @type {any} */ entry) => entry.name === name);
/** @param {any} workflow @param {any} normalized */
const condition = (workflow, normalized) =>
  vm.runInNewContext(
    node(
      workflow,
      PREFIX + 'Filtrar',
    ).parameters.conditions.conditions[0].leftValue.slice(3, -2),
    { $: () => ({ item: { json: normalized } }) },
  );
/** @param {any} workflow @param {string} name @param {any} item @param {Record<string,any>} upstream @param {Buffer} [bytes] */
async function run(workflow, name, item, upstream, bytes) {
  const result = await vm.runInNewContext(
    `(async function(){${node(workflow, name).parameters.jsCode}}).call(context)`,
    {
      $input: { item },
      $json: item.json,
      $itemIndex: 0,
      $execution: { id: '42' },
      $: (/** @type {string} */ key) => ({ item: upstream[key] }),
      Buffer,
      context: {
        helpers: {
          getBinaryDataBuffer: async () =>
            bytes ?? Buffer.from(item.binary.data.data, 'base64'),
        },
      },
    },
  );
  return JSON.parse(JSON.stringify(result));
}

test('INBOX-AUDIO-01: only filter and measurement change; identities, commercial graph, credentials and settings survive', () => {
  const source = fixture();
  const before = JSON.stringify(source);
  const { workflow, changedNodeNames } = patchEvolutionInboundAudio(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(changedNodeNames, [PREFIX + 'Filtrar', PREFIX + 'Medir']);
  const restored = structuredClone(workflow);
  for (const name of changedNodeNames)
    node(restored, name).parameters = structuredClone(
      node(source, name).parameters,
    );
  assert.deepEqual(restored, source);
  assert.equal(workflow.active, true);
  assert.equal(workflow.activeVersionId, source.activeVersionId);
  assert.deepEqual(patchEvolutionInboundAudio(workflow), {
    workflow,
    changedNodeNames: [],
  });
});

test('INBOX-AUDIO-01: OGG/MP3 and images persist in human, AI and replay; mismatched MIME/kind or channel stay excluded', () => {
  const { workflow } = patchEvolutionInboundAudio(fixture());
  for (const mode of ['human', 'handoff_pending', 'ai_active'])
    for (const duplicate of [false, true])
      for (const [message_type, media_mime_type] of [
        ['audio', 'audio/ogg; codecs=opus'],
        ['audio', 'audio/mpeg'],
        ['image', 'image/png'],
        ['image', 'image/jpeg'],
        ['image', 'image/webp'],
      ])
        assert.equal(
          condition(workflow, {
            channel: 'whatsapp',
            mode,
            duplicate,
            message_type,
            media_mime_type,
          }),
          true,
        );
  for (const overrides of [
    { channel: 'site_chat' },
    { message_type: 'video' },
    { message_type: 'image' },
    { media_mime_type: 'image/png' },
    { media_mime_type: 'audio/webm' },
    { media_mime_type: 'audio/mp4' },
    { media_mime_type: 'audio/wav' },
    { media_mime_type: 'text/html' },
    { media_mime_type: null },
  ])
    assert.equal(
      condition(workflow, {
        channel: 'whatsapp',
        message_type: 'audio',
        media_mime_type: 'audio/ogg',
        ...overrides,
      }),
      false,
    );
});

test('INBOX-AUDIO-01: provider audio event flows through decoder, digest and unchanged attachment binding without AI or another send', async () => {
  const { workflow } = patchEvolutionInboundAudio(fixture());
  for (const [mimetype, ext] of [
    ['audio/ogg; codecs=opus', 'ogg'],
    ['audio/mpeg', 'mp3'],
  ]) {
    const raw = {
      instance: 'silmer',
      event: 'messages.upsert',
      sender: config.ownNumber + '@s.whatsapp.net',
      date_time: '2026-10-29T12:00:30.123Z',
      data: {
        key: {
          id: 'SYNTHETIC_AUDIO_' + ext,
          remoteJid: '5511000000001@s.whatsapp.net',
          fromMe: false,
        },
        messageTimestamp: 1793275200,
        message: { audioMessage: { mimetype, seconds: 2, ptt: true } },
      },
    };
    const converted = convertEvolutionEvent(
      validateEvolutionEvent(raw, { ...config, session: 'silmer' }),
      null,
      config,
    );
    const normalized = await run(workflow, NORMALIZE, { json: converted }, {});
    /** @type {Record<string, any>} */
    const upstream = {
      [NORMALIZE]: normalized,
      [INBOUND]: {
        json: { conversation_id: 'conversation-synthetic', mode: 'human' },
      },
    };
    assert.equal(normalized.json.message_type, 'audio');
    assert.equal(condition(workflow, normalized.json), true);
    // Fixture bytes test preservation, not codec playback or scanner acceptance.
    const bytes = Buffer.from('synthetic-' + ext + '-bytes');
    const downloaded = await run(
      workflow,
      PREFIX + 'Baixar',
      { json: { mimetype, base64: bytes.toString('base64') } },
      upstream,
    );
    const measured = await run(
      workflow,
      PREFIX + 'Medir',
      downloaded,
      upstream,
    );
    assert.equal(measured.json.filename, 'audio.' + ext);
    assert.equal(measured.json.mime_type, mimetype.split(';')[0]);
    assert.deepEqual(Buffer.from(measured.binary.data.data, 'base64'), bytes);
    upstream[PREFIX + 'Medir'] = measured;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const prepared = await run(
      workflow,
      PREFIX + 'Preparar anexo',
      { json: { media_sha256: digest } },
      upstream,
    );
    assert.equal(prepared.json.content_sha256, digest);
    assert.equal(prepared.json.external_id, raw.data.key.id);
    assert.equal(prepared.json.idempotency_key, raw.data.key.id);
    assert.equal(prepared.json.conversation_id, 'conversation-synthetic');
    assert.deepEqual(prepared.binary, measured.binary);
    assert.deepEqual(
      await run(
        workflow,
        PREFIX + 'Preparar anexo',
        { json: { media_sha256: digest } },
        upstream,
      ),
      prepared,
    );
    assert.equal(
      vm.runInNewContext(
        node(workflow, PREFIX + 'Salvar no CRM').parameters.url.slice(3, -2),
        { $json: prepared.json },
      ),
      'https://crm.invalid/api/v1/integrations/n8n/conversations/conversation-synthetic/attachments',
    );
  }
  const visited = new Set();
  const pending = [PREFIX + 'Filtrar'];
  while (pending.length) {
    const name = pending.pop();
    if (!name || visited.has(name)) continue;
    visited.add(name);
    assert.ok(name.startsWith(PREFIX));
    for (const output of workflow.connections[name]?.main ?? [])
      for (const edge of output) pending.push(edge.node);
  }
  assert.equal(visited.size, 9);
});

test('INBOX-AUDIO-01: 16MiB audio / 5MiB image limits, missing bytes and binary MIME mismatch fail before upload', async () => {
  const { workflow } = patchEvolutionInboundAudio(fixture());
  for (const [kind, mime, limit] of [
    ['audio', 'audio/ogg', 16],
    ['audio', 'audio/mpeg', 16],
    ['image', 'image/png', 5],
  ]) {
    const upstream = {
      [NORMALIZE]: {
        json: {
          channel: 'whatsapp',
          message_type: kind,
          media_mime_type: mime,
        },
      },
    };
    const item = { json: {}, binary: { data: { id: 'ref', mimeType: mime } } };
    const size = Number(limit) * 1024 * 1024;
    assert.equal(
      (
        await run(
          workflow,
          PREFIX + 'Medir',
          item,
          upstream,
          Buffer.alloc(size),
        )
      ).binary.data.id,
      'ref',
    );
    for (const bytes of [Buffer.alloc(0), Buffer.alloc(size + 1)])
      await assert.rejects(
        run(workflow, PREFIX + 'Medir', item, upstream, bytes),
        /INBOUND_MEDIA_INVALID/u,
      );
    await assert.rejects(
      run(workflow, PREFIX + 'Medir', { json: {} }, upstream),
      /INBOUND_MEDIA_MISSING/u,
    );
    await assert.rejects(
      run(
        workflow,
        PREFIX + 'Medir',
        { json: {}, binary: { data: { mimeType: 'text/html' } } },
        upstream,
        Buffer.from('synthetic'),
      ),
      /INBOUND_MEDIA_INVALID/u,
    );
    upstream[NORMALIZE].json.message_type = 'video';
    await assert.rejects(
      run(workflow, PREFIX + 'Medir', item, upstream, Buffer.from('synthetic')),
      /INBOUND_MEDIA_INVALID/u,
    );
  }
});

test('INBOX-AUDIO-01: rejects unexpected code, partial patch, disabled/missing/ambiguous nodes, disconnected branch and foreign adapters', () => {
  const patched = patchEvolutionInboundAudio(fixture()).workflow;
  for (const change of [
    (/** @type {any} */ source) => {
      node(
        source,
        PREFIX + 'Filtrar',
      ).parameters.conditions.conditions[0].leftValue = '=true';
    },
    (/** @type {any} */ source) => {
      node(source, PREFIX + 'Medir').parameters.jsCode += '\nunknown();';
    },
    (/** @type {any} */ source) => {
      node(source, PREFIX + 'Medir').parameters = structuredClone(
        node(patched, PREFIX + 'Medir').parameters,
      );
    },
    (/** @type {any} */ source) => {
      node(source, PREFIX + 'Medir').disabled = true;
    },
    (/** @type {any} */ source) => {
      source.nodes.push(structuredClone(node(source, PREFIX + 'Medir')));
    },
    (/** @type {any} */ source) => {
      source.nodes = source.nodes.filter(
        (/** @type {any} */ entry) => entry.name !== PREFIX + 'SHA256',
      );
    },
    (/** @type {any} */ source) => {
      source.connections[INBOUND].main[0] = [];
    },
    (/** @type {any} */ source) => {
      source.connections[PREFIX + 'Medir'].main[0].push({
        node: 'WhatsApp - Enviar texto humano (MVP)',
        type: 'main',
        index: 0,
      });
    },
    (/** @type {any} */ source) => {
      node(source, PREFIX + 'Consultar URL').parameters.url =
        'https://foreign.invalid/media';
    },
    (/** @type {any} */ source) => {
      delete node(source, PREFIX + 'Consultar URL').credentials;
    },
  ]) {
    const source = fixture();
    change(source);
    assert.throws(() => patchEvolutionInboundAudio(source));
  }
});

test('INBOX-AUDIO-01: CLI creates an exclusive private review copy and never overwrites or prints payloads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-evolution-audio-'));
  const input = join(directory, 'source.json');
  const output = join(directory, 'review.json');
  const original = JSON.stringify([fixture()]);
  await writeFile(input, original);
  const command = fileURLToPath(
    new URL('../ops/n8n/patch-evolution-inbound-audio.mjs', import.meta.url),
  );
  const cli = () =>
    spawnSync(process.execPath, [command, input, output], { encoding: 'utf8' });
  const result = cli();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Prepared 2 node changes offline/u);
  assert.match(result.stdout, /nothing was published/u);
  assert.equal(result.stdout.includes('synthetic-crm'), false);
  assert.equal(await readFile(input, 'utf8'), original);
  const review = await readFile(output, 'utf8');
  assert.equal(JSON.parse(review)[0].nodes.length, fixture().nodes.length);
  assert.notEqual(cli().status, 0);
  assert.equal(await readFile(output, 'utf8'), review);
});
