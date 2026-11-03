import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';
import { patchWorkflowFailureDiagnostics } from '../ops/n8n/patch-workflow-failure-diagnostics.mjs';

const TARGET = 'Preparar workflow.failed (MVP)';
const source = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
/** @param {any} workflow */
const failureNode = (workflow) =>
  workflow.nodes.find((/** @type {any} */ node) => node.name === TARGET);
/** @param {any} workflow @param {any} lastNodeExecuted */
function execute(workflow, lastNodeExecuted) {
  return JSON.parse(
    JSON.stringify(
      vm.runInNewContext(
        `(function(){${failureNode(workflow).parameters.jsCode}})()`,
        {
          $json: {
            execution: {
              id: '90440',
              lastNodeExecuted,
              error: {
                message: 'private-message-canary',
                stack: 'private-stack-canary',
                node: 'private-error-node-canary',
              },
              message: 'private-execution-message-canary',
              payload: { text: 'private-payload-canary' },
            },
          },
          $execution: { id: '90441' },
        },
      ),
    ),
  );
}

test('OPS-INBOX-ACK-04: only the failure Code node changes; publication, graph, credentials and all other code survive', () => {
  const before = JSON.stringify(source);
  const { workflow, changedNodeNames, diagnosticsMap } =
    patchWorkflowFailureDiagnostics(source);
  assert.equal(JSON.stringify(source), before);
  assert.deepEqual(changedNodeNames, [TARGET]);
  const restored = structuredClone(workflow);
  failureNode(restored).parameters.jsCode =
    failureNode(source).parameters.jsCode;
  assert.deepEqual(restored, source);
  assert.equal(
    diagnosticsMap.length,
    new Set(source.nodes.map((/** @type {any} */ node) => node.name)).size,
  );
  for (const entry of diagnosticsMap) {
    assert.deepEqual(Object.keys(entry), ['code', 'nodeName']);
    assert.equal(
      entry.code,
      'WORKFLOW_NODE_' +
        createHash('sha256')
          .update(entry.nodeName)
          .digest('hex')
          .slice(0, 12)
          .toUpperCase(),
    );
  }
  const again = patchWorkflowFailureDiagnostics(workflow);
  assert.deepEqual(again.workflow, workflow);
  assert.deepEqual(again.changedNodeNames, []);
  assert.deepEqual(again.diagnosticsMap, diagnosticsMap);
});

test('known failures produce a safe node code with the unchanged event contract and no execution error payload', () => {
  const { workflow, diagnosticsMap } = patchWorkflowFailureDiagnostics(source);
  for (const { nodeName, code } of diagnosticsMap) {
    const result = execute(workflow, nodeName);
    assert.deepEqual(result.json.payload.failure, {
      code,
      node: nodeName.slice(0, 128),
    });
    assert.equal(result.json.payload.event_type, 'workflow.failed');
    assert.equal(result.json.payload.conversation_id, null);
    assert.equal(result.json.payload.event_id, 'workflow-failed:90440');
    assert.equal(result.json.idempotency_key, 'workflow-failed:90440');
    assert.equal(result.json.correlation_id, '0000000000090441');
    assert.equal(JSON.stringify(result).includes('canary'), false);
  }
  assert.doesNotMatch(
    failureNode(workflow).parameters.jsCode,
    /require\(|import\s|crypto\./u,
  );
});

test('unknown node data is never forwarded; missing and prototype-like values fall back safely', () => {
  const { workflow } = patchWorkflowFailureDiagnostics(source);
  for (const value of [
    'private-node-canary',
    '__proto__',
    'constructor',
    '',
    undefined,
    null,
    { message: 'private-node-object-canary' },
  ]) {
    const result = execute(workflow, value);
    assert.deepEqual(result.json.payload.failure, {
      code: 'WORKFLOW_FAILED',
      node: 'unknown',
    });
    assert.equal(JSON.stringify(result).includes('canary'), false);
  }
});

test('guards reject missing/duplicate targets and changed code shapes rather than patch another node', () => {
  const missing = structuredClone(source);
  missing.nodes = missing.nodes.filter(
    (/** @type {any} */ node) => node.name !== TARGET,
  );
  assert.throws(
    () => patchWorkflowFailureDiagnostics(missing),
    /MISSING_OR_AMBIGUOUS/u,
  );
  const duplicate = structuredClone(source);
  duplicate.nodes.push(structuredClone(failureNode(duplicate)));
  assert.throws(
    () => patchWorkflowFailureDiagnostics(duplicate),
    /MISSING_OR_AMBIGUOUS/u,
  );
  const changed = structuredClone(source);
  failureNode(changed).parameters.jsCode = failureNode(
    changed,
  ).parameters.jsCode.replace(
    "code: 'WORKFLOW_FAILED'",
    "code: 'OTHER_FAILURE'",
  );
  assert.throws(
    () => patchWorkflowFailureDiagnostics(changed),
    /CONTEXT_MISMATCH/u,
  );
  const nodeChanged = structuredClone(source);
  failureNode(nodeChanged).parameters.jsCode = failureNode(
    nodeChanged,
  ).parameters.jsCode.replace(
    'String($json.execution?.lastNodeExecuted',
    'String($json.execution?.otherField',
  );
  assert.throws(
    () => patchWorkflowFailureDiagnostics(nodeChanged),
    /CONTEXT_MISMATCH/u,
  );
  const { workflow } = patchWorkflowFailureDiagnostics(source);
  workflow.nodes.push({ name: 'New node requiring a reviewed map' });
  assert.throws(
    () => patchWorkflowFailureDiagnostics(workflow),
    /CONTEXT_MISMATCH/u,
  );
});

test('offline CLI preserves a single-workflow export wrapper, prints only the safe map and refuses overwriting', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-diagnostics-'));
  const input = join(directory, 'export.json');
  const output = join(directory, 'review.json');
  const workflow = structuredClone(source);
  workflow.credentials = { secret: 'private-credential-canary' };
  await writeFile(input, JSON.stringify([workflow]));
  const helper = fileURLToPath(
    new URL(
      '../ops/n8n/patch-workflow-failure-diagnostics.mjs',
      import.meta.url,
    ),
  );
  const result = spawnSync(process.execPath, [helper, input, output], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const expected = patchWorkflowFailureDiagnostics(workflow);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [
    expected.workflow,
  ]);
  assert.deepEqual(JSON.parse(result.stdout), {
    changedNodeNames: expected.changedNodeNames,
    diagnosticsMap: expected.diagnosticsMap,
  });
  assert.equal(result.stdout.includes('canary'), false);
  const repeat = spawnSync(process.execPath, [helper, input, output], {
    encoding: 'utf8',
  });
  assert.notEqual(repeat.status, 0);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), [
    expected.workflow,
  ]);
  const overwriteSource = spawnSync(process.execPath, [helper, input, input], {
    encoding: 'utf8',
  });
  assert.notEqual(overwriteSource.status, 0);
  assert.deepEqual(JSON.parse(await readFile(input, 'utf8')), [workflow]);
});
