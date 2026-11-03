import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { patchEvolutionFailureReasons } from '../ops/n8n/patch-evolution-failure-reasons.mjs';
import { patchWorkflowFailureDiagnostics } from '../ops/n8n/patch-workflow-failure-diagnostics.mjs';

const TARGET = 'Preparar workflow.failed (MVP)';
const CONVERTER = 'Evolution - Montar evento WhatsApp (MVP)';
const original = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
original.nodes.push({
  id: 'synthetic-converter',
  name: CONVERTER,
  type: 'n8n-nodes-base.code',
  parameters: {
    mode: 'runOnceForEachItem',
    jsCode: "throw new Error('EVOLUTION_IDENTITY_UNRESOLVED');",
  },
});
const { workflow: source, diagnosticsMap } =
  patchWorkflowFailureDiagnostics(original);
/** @param {any} workflow */
const code = (workflow) =>
  workflow.nodes.find((/** @type {any} */ node) => node.name === TARGET)
    .parameters;
/** @param {any} workflow @param {unknown} message @param {unknown} [lastNodeExecuted] */
function execute(workflow, message, lastNodeExecuted = CONVERTER) {
  return JSON.parse(
    JSON.stringify(
      vm.runInNewContext(`(function(){${code(workflow).jsCode}})()`, {
        $json: {
          execution: {
            id: '90440',
            lastNodeExecuted,
            error: {
              message,
              name: 'ExpressionError',
              stack: 'private-stack-canary',
              description: 'private-description-canary',
              node: 'private-error-node-canary',
            },
            payload: { text: 'private-payload-canary' },
          },
        },
        $execution: { id: '90441' },
      }),
    ),
  );
}
/** @param {string} nodeName */
const baseCode = (nodeName) =>
  diagnosticsMap.find((entry) => entry.nodeName === nodeName)?.code;

test('OPS-INBOX-ACK-05: only the existing failure reporter code changes, preserving all operational settings and contract fields', () => {
  const before = JSON.stringify(source);
  const { workflow, changedNodeNames } = patchEvolutionFailureReasons(source);
  assert.deepEqual(changedNodeNames, [TARGET]);
  assert.equal(JSON.stringify(source), before);
  const restored = structuredClone(workflow);
  code(restored).jsCode = code(source).jsCode;
  assert.deepEqual(restored, source);
  const actual = execute(workflow, 'private-message-canary');
  const expected = execute(source, 'private-message-canary');
  delete actual.json.payload.occurred_at;
  delete expected.json.payload.occurred_at;
  assert.deepEqual(actual, expected);
  assert.equal(JSON.stringify(actual).includes('canary'), false);
});

test('the converter identity error accepts the controlled prefix and n8n line suffix without emitting any suffix', () => {
  const { workflow } = patchEvolutionFailureReasons(source);
  for (const message of [
    'EVOLUTION_IDENTITY_UNRESOLVED',
    'EVOLUTION_IDENTITY_UNRESOLVED [line 168]',
    'EVOLUTION_IDENTITY_UNRESOLVED private-suffix-canary',
    'EVOLUTION_IDENTITY_UNRESOLVED\nprivate-suffix-canary',
  ]) {
    const result = execute(workflow, message);
    assert.deepEqual(result.json.payload.failure, {
      code: 'EVOLUTION_IDENTITY_UNRESOLVED',
      node: CONVERTER,
    });
    assert.equal(JSON.stringify(result).includes('canary'), false);
    assert.equal(JSON.stringify(result).includes('[line'), false);
  }
});

test('only the exact converter invalid-syntax message selects the fixed syntax enum', () => {
  const { workflow } = patchEvolutionFailureReasons(source);
  assert.equal(
    execute(workflow, 'invalid syntax').json.payload.failure.code,
    'N8N_EXPRESSION_SYNTAX',
  );
  for (const message of [
    'Invalid syntax',
    'invalid syntax ',
    'invalid syntax [line 1]',
    'private-canary invalid syntax',
    'EVOLUTION_IDENTITY_UNRESOLVED_OTHER',
    'private-message-canary',
    null,
    { message: 'invalid syntax' },
  ]) {
    const result = execute(workflow, message);
    assert.equal(result.json.payload.failure.code, baseCode(CONVERTER));
    assert.equal(JSON.stringify(result).includes('canary'), false);
  }
});

test('known enums from every other node and unknown node names retain the ACK-04 hashes and safe fallback', () => {
  const { workflow } = patchEvolutionFailureReasons(source);
  for (const { nodeName, code: knownCode } of diagnosticsMap.filter(
    (entry) => entry.nodeName !== CONVERTER,
  )) {
    for (const message of [
      'invalid syntax',
      'EVOLUTION_IDENTITY_UNRESOLVED [line 1]',
    ]) {
      assert.deepEqual(
        execute(workflow, message, nodeName).json.payload.failure,
        { code: knownCode, node: nodeName.slice(0, 128) },
      );
    }
  }
  for (const message of [
    'invalid syntax',
    'EVOLUTION_IDENTITY_UNRESOLVED private-suffix-canary',
  ]) {
    const result = execute(workflow, message, 'private-node-canary');
    assert.deepEqual(result.json.payload.failure, {
      code: 'WORKFLOW_FAILED',
      node: 'unknown',
    });
    assert.equal(JSON.stringify(result).includes('canary'), false);
  }
});

test('reapplication is identical and changed instrumentation, duplicate nodes and missing converter fail closed', () => {
  const first = patchEvolutionFailureReasons(source);
  const again = patchEvolutionFailureReasons(first.workflow);
  assert.deepEqual(again.workflow, first.workflow);
  assert.deepEqual(again.changedNodeNames, []);
  assert.throws(
    () => patchEvolutionFailureReasons(original),
    /CONTEXT_MISMATCH/u,
  );
  const changed = structuredClone(source);
  code(changed).jsCode = code(changed).jsCode.replace(
    'const workflowFailureNode =',
    'const otherNode =',
  );
  assert.throws(
    () => patchEvolutionFailureReasons(changed),
    /CONTEXT_MISMATCH/u,
  );
  const tampered = structuredClone(first.workflow);
  code(tampered).jsCode = code(tampered).jsCode.replace(
    "'N8N_EXPRESSION_SYNTAX'",
    "'OTHER_ENUM'",
  );
  assert.throws(
    () => patchEvolutionFailureReasons(tampered),
    /CONTEXT_MISMATCH/u,
  );
  const duplicate = structuredClone(source);
  duplicate.nodes.push(
    structuredClone(
      duplicate.nodes.find((/** @type {any} */ node) => node.name === TARGET),
    ),
  );
  assert.throws(
    () => patchEvolutionFailureReasons(duplicate),
    /MISSING_OR_AMBIGUOUS/u,
  );
  const missing = structuredClone(source);
  missing.nodes = missing.nodes.filter(
    (/** @type {any} */ node) => node.name !== CONVERTER,
  );
  assert.throws(
    () => patchEvolutionFailureReasons(missing),
    /MISSING_OR_AMBIGUOUS/u,
  );
});

test('offline CLI creates a separate review export and never overwrites its input or an existing output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evolution-failure-reasons-'));
  const input = join(directory, 'export.json');
  const output = join(directory, 'review.json');
  await writeFile(input, JSON.stringify([source]));
  const helper = fileURLToPath(
    new URL('../ops/n8n/patch-evolution-failure-reasons.mjs', import.meta.url),
  );
  const result = spawnSync(process.execPath, [helper, input, output], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [
    patchEvolutionFailureReasons(source).workflow,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), { changedNodeNames: [TARGET] });
  for (const destination of [input, output]) {
    const repeat = spawnSync(process.execPath, [helper, input, destination], {
      encoding: 'utf8',
    });
    assert.notEqual(repeat.status, 0);
  }
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), [source]);
});
