import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { patchEvolutionAckIdentity } from '../ops/n8n/patch-evolution-ack-identity.mjs';
import { createEvolutionWorkflow } from '../ops/n8n/workflows/create-evolution-workflow.mjs';

// Pinned pre-fix converter from the approved current transport generator.
// This independent fixture makes changes outside the reviewed branch fail.
const legacyConverter = String.raw`function convertEvolutionEvent(validated, mapping, config) {
  const pn = (/** @type {any} */ value) =>
    /^(\d{8,15})@s\.whatsapp\.net$/.exec(String(value ?? ''))?.[1] ?? null;
  let phone = validated.provider_phone;
  if (validated.needs_lid) {
    const records = mapping?.messages?.records;
    const matches = Array.isArray(records)
      ? records.filter(
          (record) =>
            record.key?.id === validated.id &&
            record.key?.remoteJid === validated.chat &&
            record.key?.fromMe === (validated.event.kind === 'ack') &&
            pn(record.key?.remoteJidAlt),
        )
      : [];
    phone = matches.length === 1 ? pn(matches[0].key.remoteJidAlt) : null;
  }
  if (!phone || phone === config.ownNumber)
    throw new Error('EVOLUTION_IDENTITY_UNRESOLVED');
  const payload = validated.event;
  const metadata = { phone_number_id: config.ownNumber };
  if (payload.kind === 'ack')
    return {
      metadata,
      statuses: [
        {
          id: validated.id,
          status: /** @type {Record<string,string>} */ ({
            ERROR: 'failed',
            DELIVERY_ACK: 'delivered',
            READ: 'read',
            PLAYED: 'read',
          })[payload.status],
          recipient_id: phone,
          timestamp: String(validated.occurred_at_seconds),
        },
      ],
    };
  const message = /** @type {any} */ ({
    id: validated.id,
    from: phone,
    timestamp: String(validated.occurred_at_seconds),
    type: payload.type,
  });
  if (payload.quoted) message.context = { id: payload.quoted };
  if (payload.type === 'text') message.text = { body: payload.text };
  else if (
    ['image', 'audio', 'video', 'document', 'sticker'].includes(payload.type)
  )
    message[payload.type] = {
      id: validated.id,
      mime_type: payload.mimetype,
      caption: payload.caption,
      filename: payload.filename,
    };
  else if (payload.type === 'contact') {
    message.type = 'text';
    message.text = { body: '[Contato compartilhado]' };
  } else if (payload.type === 'location') {
    const loc = payload.location;
    if (
      Number.isFinite(loc?.latitude) &&
      Math.abs(loc.latitude) <= 90 &&
      Number.isFinite(loc?.longitude) &&
      Math.abs(loc.longitude) <= 180
    )
      message.location = { ...loc, name: '' };
    else message.type = 'unsupported';
  }
  return {
    metadata,
    contacts: [{ wa_id: phone, profile: { name: payload.name } }],
    messages: [message],
  };
}`;
const LOOKUP = 'Evolution - Consultar identidade (MVP)';
const CONVERT = 'Evolution - Montar evento WhatsApp (MVP)';
const oldLookup =
  '={{ ({ where: { key: { id: $json.id, remoteJid: $json.chat } }, offset: 2, page: 1 }) }}';
const config = {
  ownNumber: '5511000000000',
  baseUrl: 'http://schedule_silmer-evolution:8080',
  session: 'silmer',
};
const baseline = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const wrapper =
  ";\nconst input=$('Evolution - Validar origem (MVP)').item.json;return {json:convert(input,input.needs_lid?$json:null,";
/** @param {any} workflow @param {string} name */
const node = (workflow, name) =>
  workflow.nodes.find((/** @type {any} */ item) => item.name === name);
function sourceWorkflow() {
  const workflow = createEvolutionWorkflow(baseline, config);
  workflow.id = 'synthetic-current-main';
  workflow.active = true;
  workflow.versionId = 'synthetic-current-version';
  workflow.activeVersionId = workflow.versionId;
  workflow.settings.errorWorkflow = workflow.id;
  while (workflow.nodes.length < 113)
    workflow.nodes.push({
      id: 'synthetic-extra-' + workflow.nodes.length,
      name: 'Synthetic preserved node ' + workflow.nodes.length,
      type: 'n8n-nodes-base.noOp',
      parameters: { marker: 'keep-private-credential-canary' },
    });
  node(workflow, LOOKUP).parameters.jsonBody = oldLookup;
  node(workflow, CONVERT).parameters.jsCode =
    'const convert=' +
    legacyConverter +
    wrapper +
    JSON.stringify(config) +
    ')};';
  node(workflow, LOOKUP).credentials = {
    httpHeaderAuth: { id: 'private-credential-canary', name: 'Synthetic' },
  };
  return workflow;
}

test('OPS-INBOX-ACK-05: patches exactly lookup body and converter on the living export', () => {
  const source = sourceWorkflow();
  const before = structuredClone(source);
  const { workflow, changedNodeNames } = patchEvolutionAckIdentity(source);
  assert.deepEqual(source, before);
  assert.deepEqual(changedNodeNames, [LOOKUP, CONVERT]);
  assert.equal(workflow.nodes.length, source.nodes.length);
  const restored = structuredClone(workflow);
  node(restored, LOOKUP).parameters.jsonBody = node(
    source,
    LOOKUP,
  ).parameters.jsonBody;
  node(restored, CONVERT).parameters.jsCode = node(
    source,
    CONVERT,
  ).parameters.jsCode;
  assert.deepEqual(restored, source);
  assert.deepEqual(patchEvolutionAckIdentity(workflow), {
    workflow,
    changedNodeNames: [],
  });
  const checked = {
    id: 'SYNTHETIC_ACK',
    chat: '123456@lid',
    needs_lid: true,
    provider_phone: null,
    occurred_at_seconds: 1793719050,
    event: { kind: 'ack', status: 'READ' },
  };
  const result = vm.runInNewContext(
    '(function(){' + node(workflow, CONVERT).parameters.jsCode + '})()',
    {
      $json: {
        messages: {
          records: [
            {
              key: {
                id: checked.id,
                fromMe: true,
                remoteJid: '5511000000001@s.whatsapp.net',
              },
              status: 'PENDING',
            },
          ],
        },
      },
      $: (/** @type {string} */ name) => {
        assert.equal(name, 'Evolution - Validar origem (MVP)');
        return { item: { json: checked } };
      },
    },
  );
  assert.equal(result.json.statuses[0].status, 'read');
  assert.equal(result.json.statuses[0].id, checked.id);
  assert.equal(result.json.messages, undefined);
  assert.equal(result.json.contacts, undefined);
});

test('OPS-INBOX-ACK-05: missing, duplicate, partial or independently changed contexts fail closed', () => {
  for (const change of [
    (/** @type {any} */ workflow) => {
      workflow.nodes = workflow.nodes.filter(
        (/** @type {any} */ item) => item.name !== LOOKUP,
      );
    },
    (/** @type {any} */ workflow) => {
      workflow.nodes.push(structuredClone(node(workflow, CONVERT)));
    },
    (/** @type {any} */ workflow) => {
      node(workflow, CONVERT).parameters.mode = 'runOnceForAllItems';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, LOOKUP).parameters.method = 'GET';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, LOOKUP).parameters.url += '/unexpected';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, LOOKUP).parameters.jsonBody = '={{ $json }}';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, CONVERT).parameters.jsCode += '\n// unreviewed change';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, CONVERT).parameters.jsCode = node(
        workflow,
        CONVERT,
      ).parameters.jsCode.replace('phone === config.ownNumber', 'false');
    },
    (/** @type {any} */ workflow) => {
      node(workflow, LOOKUP).parameters.jsonBody = node(
        patchEvolutionAckIdentity(workflow).workflow,
        LOOKUP,
      ).parameters.jsonBody;
    },
    (/** @type {any} */ workflow) => {
      node(workflow, CONVERT).parameters.jsCode = node(
        workflow,
        CONVERT,
      ).parameters.jsCode.replace(
        JSON.stringify(config),
        '{"ownNumber":"invalid","baseUrl":"http://untrusted.invalid","session":"silmer"}',
      );
    },
  ]) {
    const workflow = sourceWorkflow();
    change(workflow);
    const before = structuredClone(workflow);
    assert.throws(
      () => patchEvolutionAckIdentity(workflow),
      /^Error: EVOLUTION_ACK_/u,
    );
    assert.deepEqual(workflow, before);
  }
});

test('OPS-INBOX-ACK-05: the offline CLI never prints private config or overwrites an export', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evolution-ack-'));
  const input = join(directory, 'export.json');
  const output = join(directory, 'review.json');
  const workflow = sourceWorkflow();
  await writeFile(input, JSON.stringify([workflow]));
  const helper = fileURLToPath(
    new URL('../ops/n8n/patch-evolution-ack-identity.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [helper, input, output], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    changedNodeNames: [LOOKUP, CONVERT],
  });
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /551100|private-credential|http:\/\//u,
  );
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [
    patchEvolutionAckIdentity(workflow).workflow,
  ]);
  const repeat = spawnSync(process.execPath, [helper, input, output], {
    encoding: 'utf8',
  });
  assert.notEqual(repeat.status, 0);
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), [workflow]);
  const overwrite = spawnSync(process.execPath, [helper, input, input], {
    encoding: 'utf8',
  });
  assert.notEqual(overwrite.status, 0);
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), [workflow]);
});
