import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { organizeVendedorWorkflow } from '../ops/n8n/workflows/organize-vendedor-workflow.mjs';

// CHAN-WA-01: layout is a presentation change, with no executable drift.
const canonical = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const NOTE_TYPE = 'n8n-nodes-base.stickyNote';
const GUIDES = [
  'GUIA 01 — Site para WhatsApp',
  'GUIA 02 — Atendimento WhatsApp',
  'GUIA 03 — Operação humana',
  'GUIA 04 — Falhas e reconciliação',
  'GUIA 05 — Compatibilidade histórica',
];

/** Synthetic operational fields make unintended overwrites observable. */
function operationalFixture() {
  const source = structuredClone(canonical);
  source.id = 'synthetic-operational-workflow';
  source.active = false;
  source.versionId = 'synthetic-version';
  source.settings = {
    ...source.settings,
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'none',
    executionTimeout: 123,
  };
  source.pinData = { synthetic: [] };
  source.tags = [{ id: 'synthetic-tag', name: 'Synthetic' }];
  source.nodes.forEach(
    (/** @type {any} */ node, /** @type {number} */ index) => {
      node.id = 'synthetic-node:' + index;
      node.webhookId = 'synthetic-webhook:' + index;
      node.credentials = {
        httpBasicAuth: { id: 'fake-id', name: 'fake-name' },
      };
      node.parameters.syntheticOperationalUrl =
        'https://synthetic.invalid/hook';
      node.position = [index * 13, index * 17];
    },
  );
  return source;
}

/** @param {any} node */
function withoutPosition(node) {
  const result = structuredClone(node);
  delete result.position;
  return result;
}

/** @param {any} node */
function bodyBox(node) {
  // n8n renders AI model/parser subnodes as 80px circles; ordinary nodes use
  // 96px bodies. Notes intentionally surround nodes and are checked separately.
  const subnode =
    node.type.startsWith('@n8n/n8n-nodes-langchain.lm') ||
    node.type.includes('outputParser');
  const size = subnode ? 80 : 96;
  return { x: node.position[0], y: node.position[1], w: size, h: size };
}

/** @param {any} first @param {any} second */
function overlaps(first, second) {
  return (
    first.x < second.x + second.w &&
    second.x < first.x + first.w &&
    first.y < second.y + second.h &&
    second.y < first.y + first.h
  );
}

test('layout preserves every executable field, credential, webhook, edge and setting', () => {
  const source = operationalFixture();
  const before = structuredClone(source);
  const result = organizeVendedorWorkflow(source);
  assert.deepEqual(source, before, 'the input export must remain unchanged');
  assert.deepEqual(result.connections, before.connections);
  const metadata = { ...result };
  const expectedMetadata = { ...before };
  delete metadata.nodes;
  delete expectedMetadata.nodes;
  assert.deepEqual(metadata, expectedMetadata);
  const executable = result.nodes.filter(
    (/** @type {any} */ node) => node.type !== NOTE_TYPE,
  );
  assert.equal(executable.length, before.nodes.length);
  for (const previous of before.nodes) {
    const actual = executable.find(
      (/** @type {any} */ node) => node.name === previous.name,
    );
    assert.ok(actual, previous.name);
    assert.deepEqual(
      withoutPosition(actual),
      withoutPosition(previous),
      previous.name,
    );
  }
});

test('layout adds five stable, non-executable guides and is deterministic and idempotent', () => {
  const source = operationalFixture();
  const first = organizeVendedorWorkflow(source);
  const second = organizeVendedorWorkflow(source);
  const repeated = organizeVendedorWorkflow(first);
  assert.deepEqual(second, first);
  assert.deepEqual(repeated, first);
  const notes = first.nodes.filter(
    (/** @type {any} */ node) => node.type === NOTE_TYPE,
  );
  assert.deepEqual(
    notes.map((/** @type {any} */ node) => node.name).sort(),
    GUIDES,
  );
  assert.equal(
    new Set(notes.map((/** @type {any} */ node) => node.id)).size,
    5,
  );
  for (const note of notes) {
    assert.match(note.parameters.content, /^## \d\d · /u);
    assert.ok(note.parameters.width >= 1100);
    assert.ok(note.parameters.height >= 480);
    assert.equal(note.credentials, undefined);
    assert.equal(note.webhookId, undefined);
    assert.equal(first.connections[note.name], undefined);
  }
});

test('all executable node bodies are disjoint, including AI model and parser subnodes', () => {
  const result = organizeVendedorWorkflow(operationalFixture());
  const nodes = result.nodes.filter(
    (/** @type {any} */ node) => node.type !== NOTE_TYPE,
  );
  assert.ok(
    nodes.some((/** @type {any} */ node) => node.type.includes('lmChatOpenAi')),
  );
  assert.ok(
    nodes.some((/** @type {any} */ node) => node.type.includes('outputParser')),
  );
  for (let index = 0; index < nodes.length; index += 1) {
    const first = nodes[index];
    assert.equal(first.position.length, 2);
    assert.ok(first.position.every(Number.isFinite), first.name);
    for (const second of nodes.slice(index + 1)) {
      assert.equal(
        overlaps(bodyBox(first), bodyBox(second)),
        false,
        `${first.name} overlaps ${second.name}`,
      );
    }
  }
});

test('guides occupy separate bands and contain every node in exactly one section', () => {
  const result = organizeVendedorWorkflow(operationalFixture());
  const notes = result.nodes.filter(
    (/** @type {any} */ node) => node.type === NOTE_TYPE,
  );
  const boxes = notes.map((/** @type {any} */ node) => ({
    x: node.position[0],
    y: node.position[1],
    w: node.parameters.width,
    h: node.parameters.height,
  }));
  for (let index = 0; index < boxes.length; index += 1) {
    for (const other of boxes.slice(index + 1)) {
      assert.equal(overlaps(boxes[index], other), false);
    }
  }
  for (const node of result.nodes.filter(
    (/** @type {any} */ candidate) => candidate.type !== NOTE_TYPE,
  )) {
    const body = bodyBox(node);
    const containers = boxes.filter(
      (/** @type {any} */ section) =>
        body.x >= section.x &&
        body.y >= section.y + 160 &&
        body.x + body.w <= section.x + section.w &&
        body.y + body.h <= section.y + section.h,
    );
    assert.equal(containers.length, 1, node.name);
  }
});

test('a routing cycle fails without silently rewriting executable edges', () => {
  const source = operationalFixture();
  const root = 'WhatsApp - Receber eventos (MVP)';
  source.connections[root] = {
    main: [[{ node: root, type: 'main', index: 0 }]],
  };
  const before = structuredClone(source);
  assert.throws(
    () => organizeVendedorWorkflow(source),
    /LAYOUT_CYCLE_REQUIRES_REVIEW/u,
  );
  assert.deepEqual(source, before);
});

test('reserved guide names cannot silently remove an executable node', () => {
  for (const name of GUIDES) {
    const source = operationalFixture();
    source.nodes.push({
      id: 'synthetic-collision',
      name,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [0, 0],
      parameters: { jsCode: 'return { json: {} };' },
    });
    const before = structuredClone(source);
    assert.throws(
      () => organizeVendedorWorkflow(source),
      /LAYOUT_GUIDE_NAME_COLLISION/u,
      name,
    );
    assert.deepEqual(source, before);
  }
});
