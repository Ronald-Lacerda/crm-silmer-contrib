import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const directory = new URL('ops/n8n/workflows/', root);
const manifest = JSON.parse(
  await readFile(new URL('production-reference.json', directory), 'utf8'),
);
const published = JSON.parse(
  await readFile(new URL(manifest.operationalSourceOfTruth, directory), 'utf8'),
);
const pending = JSON.parse(
  await readFile(new URL('pending-features.json', directory), 'utf8'),
);
const digest = (/** @type {string | Buffer} */ value) =>
  createHash('sha256').update(value).digest('hex');
const stable = (/** @type {any} */ value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
const node = (/** @type {string} */ name) => {
  const found = published.nodes.find(
    (/** @type {any} */ item) => item.name === name,
  );
  assert.ok(found, name);
  return found;
};

test('SIL-36: reference matches the published capture fingerprints and topology', () => {
  assert.equal(manifest.publishedVersionId, published.source.activeVersionId);
  assert.equal(manifest.workflowId, published.source.workflowId);
  assert.equal(published.source.active, true);
  assert.equal(published.active, false);
  assert.equal(manifest.deployable, false);
  assert.equal(published.nodes.length, 141);
  for (const [key, value] of Object.entries({
    nodes: published.nodes,
    connections: published.connections,
    settings: published.settings,
    groups: published.nodeGroups,
  }))
    assert.equal(
      digest(stable(value)),
      manifest.sanitizedFingerprints[key],
      key,
    );
  const names = new Set(published.nodes.map((/** @type {any} */ n) => n.name));
  const ids = new Set(published.nodes.map((/** @type {any} */ n) => n.id));
  assert.equal(names.size, 141);
  assert.equal(ids.size, 141);
  for (const [source, ports] of Object.entries(published.connections)) {
    assert.ok(names.has(source), source);
    for (const outputs of Object.values(/** @type {any} */ (ports)))
      for (const targets of outputs)
        for (const target of targets)
          assert.ok(names.has(target.node), target.node);
  }
  assert.equal(
    digest(stable(published.connections)),
    published.source.rawConnectionsSha256,
  );
});

test('SIL-36: published reference contains no private bindings or execution data', () => {
  const inspect = (/** @type {any} */ value) => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https?:\/\/[^/\s"'`]+/gu)) {
        const host = new URL(match[0]).hostname;
        assert.ok(
          host.endsWith('.invalid') ||
            ['api.openai.com', 'graph.facebook.com', 'wa.me'].includes(host),
          host,
        );
      }
      assert.doesNotMatch(value, /"ownNumber"\s*:\s*"[0-9]{8,15}"/u);
      assert.doesNotMatch(value, /wa\.me\/[0-9]{8,15}/u);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!['credentials', 'webhookId', 'pinData'].includes(key), key);
      inspect(item);
    }
  };
  inspect(published);
  const integrityHeader = node(
    'Inbox - Imagem recebida - Salvar no CRM',
  ).parameters.headerParameters.parameters.find(
    (/** @type {any} */ header) => header.name === 'X-Silmer-Content-SHA256',
  );
  assert.equal(integrityHeader.value, '={{ $json.content_sha256 }}');
  assert.equal(manifest.sanitization.credentialNodesRemoved, 39);
  assert.equal(manifest.sanitization.webhookIdsRemoved, 8);
  const headers = published.nodes.flatMap((/** @type {any} */ n) =>
    (n.parameters?.headerParameters?.parameters ?? [])
      .filter(
        (/** @type {any} */ h) =>
          h.name.toLowerCase() === 'x-silmer-workflow-version',
      )
      .map((/** @type {any} */ h) => ({ node: n.name, version: h.value })),
  );
  assert.deepEqual(headers, manifest.versionHeaders);
});

test('SIL-36: preserves every prior n8n artifact and each pending feature source', async () => {
  for (const [path, hash] of Object.entries(manifest.preservedArtifactsSha256))
    assert.equal(digest(await readFile(new URL(path, root))), hash, path);
  const candidate = JSON.parse(
    await readFile(new URL(manifest.candidate.path, directory), 'utf8'),
  );
  assert.equal(candidate.nodes.length, 115);
  assert.equal(pending.items.length, 12);
  assert.equal(
    new Set(pending.items.map((/** @type {any} */ item) => item.issue)).size,
    12,
  );
  for (const item of pending.items) {
    assert.match(item.issue, /^SIL-[0-9]+$/u);
    assert.equal(item.status, 'pending');
    assert.equal(item.source, manifest.candidate.path);
    assert.ok(
      manifest.preservedArtifactsSha256['ops/n8n/workflows/' + item.sdk],
    );
    for (const name of item.nodes)
      assert.ok(
        candidate.nodes.some((/** @type {any} */ n) => n.name === name),
        name,
      );
  }
});

test('SIL-36: published reservation still cancels only the closed stale fence', () => {
  const request = node('CRM - Reservar envio da IA (MVP)');
  const validate = node('CRM - Validar reserva da IA (MVP)');
  assert.equal(request.retryOnFail, false);
  assert.equal(request.parameters.options.response.response.fullResponse, true);
  assert.equal(request.parameters.options.response.response.neverError, true);
  assert.equal(validate.parameters.mode, 'runOnceForAllItems');
  const run = (/** @type {any[]} */ responses) =>
    JSON.parse(
      JSON.stringify(
        vm.runInNewContext(
          '(function(){' + validate.parameters.jsCode + '})()',
          { $input: { all: () => responses.map((json) => ({ json })) } },
          { timeout: 1000 },
        ),
      ),
    );
  const stale = {
    statusCode: 409,
    body: {
      status: 409,
      accepted: false,
      error: { code: 'STALE_AUTOMATION_FENCE' },
      type: 'urn:silmer:problem:stale_automation_fence',
    },
  };
  assert.deepEqual(run([stale]), []);
  const body = { accepted: true, send_authorized: false, duplicate: true };
  assert.deepEqual(run([stale, { statusCode: 202, body }]), [
    { json: body, pairedItem: { item: 1 } },
  ]);
  for (const response of [
    { statusCode: 401, body: {} },
    { statusCode: 500, body: {} },
    { ...stale, body: { ...stale.body, error: { code: 'OTHER_CONFLICT' } } },
    { ...stale, body: { ...stale.body, accepted: true } },
  ])
    assert.throws(() => run([response]), /AI_RESERVATION_HTTP_/u);
  assert.throws(
    () => run([{ statusCode: 200, body: {} }]),
    /AI_RESERVATION_RESPONSE_INVALID/u,
  );
});

test('SIL-36: operational additions remain present without silently applying pending extras', () => {
  assert.equal(
    published.nodes.filter((/** @type {any} */ n) =>
      n.name.startsWith('Inbox - Imagem recebida - '),
    ).length,
    9,
  );
  assert.match(
    node('Preparar workflow.failed (MVP)').parameters.jsCode,
    /EVOLUTION_IDENTITY_UNRESOLVED/u,
  );
  assert.equal(published.settings.errorWorkflow, manifest.workflowId);
  assert.equal(node('WhatsApp - Receber eventos (MVP)').disabled, undefined);
  assert.match(
    node('Montar contexto da IA (MVP)').parameters.jsCode,
    /AGENTE-OBS-03 telemetry overlay/u,
  );
  assert.ok(
    !published.nodes.some(
      (/** @type {any} */ n) =>
        n.name === 'Preparar handoff de falha da IA (MVP)',
    ),
  );
  assert.ok(
    !published.nodes.some(
      (/** @type {any} */ n) =>
        n.name === 'CRM - Registrar transcrição do áudio (MVP)',
    ),
  );
});
