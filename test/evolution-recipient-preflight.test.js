import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  evolutionRecipientRegistered,
  patchEvolutionRecipientPreflight,
} from '../ops/n8n/evolution-recipient-preflight.mjs';
import { createEvolutionWorkflow } from '../ops/n8n/workflows/create-evolution-workflow.mjs';

const CHECK = 'Evolution - Consultar destinatario humano (MVP)';
const VALIDATE = 'Evolution - Validar destinatario humano (MVP)';
const ALLOWED = 'Evolution - Destinatario humano reconhecido? (MVP)';
const NOT_FOUND = 'Evolution - Destinatario humano nao encontrado (MVP)';
const UNAVAILABLE = 'Evolution - Consulta de destinatario indisponivel (MVP)';
const SITE = 'Resposta humana pelo site? (MVP)';
const MEDIA = 'Mensagem humana tem midia? (MVP)';
const RESERVE = 'Preparar reserva de envio humano (MVP)';
const RECORD = 'CRM - Concluir falha do destinatario (MVP)';
const REJECT = 'Responder destinatario recusado (MVP)';
const added = [
  CHECK,
  VALIDATE,
  ALLOWED,
  NOT_FOUND,
  UNAVAILABLE,
  RECORD,
  REJECT,
];
const to = '5511000000001';
const entry = { number: to, jid: `${to}@s.whatsapp.net`, exists: true };
const baseline = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const generated = createEvolutionWorkflow(baseline, {
  ownNumber: '5511000000000',
  apiCredentialId: 'synthetic-api',
});
const node = (/** @type {any} */ w, /** @type {string} */ name) =>
  w.nodes.find((/** @type {any} */ n) => n.name === name);
function sourceWorkflow() {
  const w = structuredClone(generated);
  w.nodes = w.nodes.filter((/** @type {any} */ n) => !added.includes(n.name));
  for (const name of added) delete w.connections[name];
  w.connections[SITE].main[1] = [{ node: MEDIA, type: 'main', index: 0 }];
  w.active = true;
  w.versionId = 'synthetic-living-version';
  w.activeVersionId = w.versionId;
  return w;
}

test('OPS-INBOX-SEND-06: a single explicit provider assertion releases the unchanged recipient', () => {
  assert.equal(evolutionRecipientRegistered([entry], to), true);
  assert.equal(
    evolutionRecipientRegistered([{ ...entry, exists: false }], to),
    false,
  );
  assert.equal(
    evolutionRecipientRegistered([{ ...entry, jid: '5511000000002@lid' }], to),
    true,
  );
  for (const length of [1, 16, 30])
    assert.equal(
      evolutionRecipientRegistered(
        [{ ...entry, jid: '1'.repeat(length) + '@lid' }],
        to,
      ),
      true,
    );
  assert.throws(
    () =>
      evolutionRecipientRegistered(
        [{ ...entry, jid: '1'.repeat(31) + '@lid' }],
        to,
      ),
    /EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE/u,
  );
  for (const response of [
    null,
    {},
    [],
    [entry, entry],
    [null],
    [{ ...entry, number: '5511000000002' }],
    [{ ...entry, exists: 'true' }],
    [{ ...entry, jid: '123@g.us' }],
    [{ ...entry, jid: null }],
    [{ ...entry, exists: undefined }],
  ])
    assert.throws(
      () => evolutionRecipientRegistered(response, to),
      /EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE/,
    );
  assert.throws(
    () => evolutionRecipientRegistered([entry], '+123'),
    /EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE/,
  );
});

test('OPS-INBOX-SEND-06: patches only the post-reservation WhatsApp branch; private settings and provider calls survive', () => {
  const before = sourceWorkflow();
  const snapshot = structuredClone(before);
  const { workflow, changedNodeNames } =
    patchEvolutionRecipientPreflight(before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(changedNodeNames, [SITE, ...added]);
  for (const original of before.nodes)
    assert.deepEqual(node(workflow, original.name), original);
  assert.deepEqual(workflow.settings, before.settings);
  assert.equal(workflow.activeVersionId, before.activeVersionId);
  for (const [name, connections] of Object.entries(before.connections))
    if (name !== SITE)
      assert.deepEqual(workflow.connections[name], connections);
  assert.deepEqual(
    workflow.connections[SITE].main[0],
    before.connections[SITE].main[0],
  );
  assert.equal(workflow.connections[SITE].main[1][0].node, CHECK);
  assert.equal(workflow.connections[CHECK].main[1][0].node, UNAVAILABLE);
  assert.equal(workflow.connections[VALIDATE].main[1][0].node, UNAVAILABLE);
  assert.equal(workflow.connections[ALLOWED].main[0][0].node, MEDIA);
  assert.equal(workflow.connections[ALLOWED].main[1][0].node, NOT_FOUND);
  const request = node(workflow, CHECK);
  assert.match(request.parameters.url, /\/chat\/whatsappNumbers\/silmer$/);
  assert.deepEqual(
    request.credentials,
    node(before, 'WhatsApp - Enviar texto humano (MVP)').credentials,
  );
  assert.equal(request.retryOnFail, false);
  assert.equal(request.parameters.options.response.response.fullResponse, true);
  assert.equal(
    request.parameters.options.redirect.redirect.followRedirects,
    false,
  );
  assert.equal(
    node(workflow, ALLOWED).parameters.conditions.options.typeValidation,
    'strict',
  );
  assert.deepEqual(patchEvolutionRecipientPreflight(workflow), {
    workflow,
    changedNodeNames: [],
  });
});

test('OPS-INBOX-SEND-06: Code nodes emit only a boolean or allowlisted failure, never a provider payload', () => {
  const { workflow } = patchEvolutionRecipientPreflight(sourceWorkflow());
  const command = {
    command_id: 'synthetic-command',
    conversation_id: 'synthetic-conversation',
    automation_epoch: 1,
    source_revision: 2,
    to: '+' + to,
  };
  const upstream = (/** @type {string} */ name) => ({
    item: { json: name === RESERVE ? { command } : {} },
  });
  const run = (/** @type {string} */ name, /** @type {any} */ json) =>
    vm.runInNewContext(
      '(function(){' + node(workflow, name).parameters.jsCode + '})()',
      {
        $json: json,
        $: upstream,
        $execution: { id: '123' },
        Date,
      },
    );
  for (const exists of [true, false])
    assert.equal(
      JSON.stringify(
        run(VALIDATE, {
          statusCode: 200,
          body: [{ ...entry, exists }],
          headers: { private: 'canary' },
        }),
      ),
      JSON.stringify({ json: { registered: exists } }),
    );
  for (const response of [
    { statusCode: 500, body: [entry] },
    { statusCode: 401, body: [entry] },
    { statusCode: 200, body: [] },
    entry,
  ])
    assert.throws(
      () => run(VALIDATE, response),
      /EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE/,
    );
  for (const [name, code] of [
    [NOT_FOUND, 'EVOLUTION_RECIPIENT_NOT_FOUND'],
    [UNAVAILABLE, 'EVOLUTION_RECIPIENT_CHECK_UNAVAILABLE'],
  ]) {
    const result = run(name, { secret: 'private-provider-payload' }).json;
    assert.equal(result.payload.event_type, 'workflow.failed');
    assert.equal(result.payload.failure.phase, 'before_message_send');
    assert.equal(result.payload.failure.code, code);
    assert.equal(result.payload.command_id, command.command_id);
    assert.equal(result.idempotency_key, 'before-send:' + command.command_id);
    assert.equal(
      JSON.stringify(result).includes('private-provider-payload'),
      false,
    );
    assert.equal(JSON.stringify(result).includes(to), false);
    assert.equal(workflow.connections[name].main[0][0].node, RECORD);
  }
  const expression = node(workflow, CHECK)
    .parameters.jsonBody.replace(/^=\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  const request = vm.runInNewContext('(' + expression + ')', { $: upstream });
  assert.equal(JSON.stringify(request), JSON.stringify({ numbers: [to] }));
  assert.equal(command.to, '+' + to);
  assert.equal(node(workflow, REJECT).parameters.options.responseCode, 422);
  assert.match(
    node(workflow, REJECT).parameters.responseBody,
    /accepted: false/u,
  );
  assert.equal(workflow.connections[RECORD].main[0][0].node, REJECT);
});

test('OPS-INBOX-SEND-06: drift, duplicate nodes and unsafe branch rewiring fail closed', () => {
  for (const mutate of [
    (/** @type {any} */ w) => w.nodes.push({ ...node(w, SITE) }),
    (/** @type {any} */ w) => {
      node(w, 'WhatsApp - Enviar texto humano (MVP)').parameters.url =
        'https://unrelated.invalid';
    },
    (/** @type {any} */ w) => {
      w.connections[SITE].main[1][0].node =
        'WhatsApp - Enviar texto humano (MVP)';
    },
  ]) {
    const w = sourceWorkflow();
    mutate(w);
    assert.throws(
      () => patchEvolutionRecipientPreflight(w),
      /EVOLUTION_RECIPIENT_/,
    );
  }
  const w = patchEvolutionRecipientPreflight(sourceWorkflow()).workflow;
  node(w, CHECK).retryOnFail = true;
  assert.throws(
    () => patchEvolutionRecipientPreflight(w),
    /EVOLUTION_RECIPIENT_PATCH_CONTEXT_MISMATCH/,
  );
});
