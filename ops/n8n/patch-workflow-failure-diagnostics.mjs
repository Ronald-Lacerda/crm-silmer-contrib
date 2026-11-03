import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGET = 'Preparar workflow.failed (MVP)';
const MARKER =
  '// OPS-INBOX-ACK-04: allowlisted workflow failure diagnostics.\n';
const ORIGINAL_CODE = "code: 'WORKFLOW_FAILED'";
const ORIGINAL_NODE =
  "node: String($json.execution?.lastNodeExecuted ?? 'unknown').slice(0, 128)";
const PATCHED_CODE =
  "code: workflowFailureCodes.get(workflowFailureNode) ?? 'WORKFLOW_FAILED'";
const PATCHED_NODE =
  "node: workflowFailureCodes.has(workflowFailureNode) ? workflowFailureNode.slice(0, 128) : 'unknown'";

/** @param {string} code @param {string} expected @param {string} replacement */
function replaceOnce(code, expected, replacement) {
  const parts = code.split(expected);
  if (parts.length !== 2)
    throw new Error('WORKFLOW_FAILURE_PATCH_CONTEXT_MISMATCH');
  return parts[0] + replacement + parts[1];
}

/**
 * OPS-INBOX-ACK-04 / OPS-ERR-04: prepare a patch offline, without retaining
 * execution errors or altering any publication, credential or execution setting.
 * Hashes are computed here; the n8n Code node needs no crypto or other imports.
 * @param {any} source
 * @returns {{workflow:any, changedNodeNames:string[], diagnosticsMap:{code:string,nodeName:string}[]}}
 */
export function patchWorkflowFailureDiagnostics(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('WORKFLOW_INVALID');
  const targets = source.nodes.filter(
    (/** @type {any} */ node) => node.name === TARGET,
  );
  if (targets.length !== 1)
    throw new Error('WORKFLOW_NODE_MISSING_OR_AMBIGUOUS');
  const target = targets[0];
  if (
    target.type !== 'n8n-nodes-base.code' ||
    target.parameters?.mode !== 'runOnceForEachItem' ||
    typeof target.parameters?.jsCode !== 'string'
  )
    throw new Error('WORKFLOW_FAILURE_NODE_SHAPE_INVALID');
  const names = source.nodes.map((/** @type {any} */ node) => node.name);
  if (
    names.some((/** @type {any} */ name) => typeof name !== 'string' || !name)
  )
    throw new Error('WORKFLOW_NODE_NAME_INVALID');
  const diagnosticsMap = [...new Set(/** @type {string[]} */ (names))].map(
    (nodeName) => ({
      code:
        'WORKFLOW_NODE_' +
        createHash('sha256')
          .update(nodeName)
          .digest('hex')
          .slice(0, 12)
          .toUpperCase(),
      nodeName,
    }),
  );
  if (
    new Set(diagnosticsMap.map(({ code }) => code)).size !==
    diagnosticsMap.length
  )
    throw new Error('WORKFLOW_FAILURE_CODE_COLLISION');
  const prefix =
    MARKER +
    `const workflowFailureCodes = new Map(${JSON.stringify(diagnosticsMap.map(({ code, nodeName }) => [nodeName, code]))});\n` +
    'const workflowFailureNode = $json.execution?.lastNodeExecuted;\n';
  const current = target.parameters.jsCode;
  let original = current;
  if (current.includes(MARKER)) {
    if (!current.startsWith(prefix))
      throw new Error('WORKFLOW_FAILURE_PATCH_CONTEXT_MISMATCH');
    original = replaceOnce(
      current.slice(prefix.length),
      PATCHED_CODE,
      ORIGINAL_CODE,
    );
    original = replaceOnce(original, PATCHED_NODE, ORIGINAL_NODE);
  }
  let updated = replaceOnce(original, ORIGINAL_CODE, PATCHED_CODE);
  updated = prefix + replaceOnce(updated, ORIGINAL_NODE, PATCHED_NODE);
  const workflow = structuredClone(source);
  workflow.nodes.find(
    (/** @type {any} */ node) => node.name === TARGET,
  ).parameters.jsCode = updated;
  return {
    workflow,
    changedNodeNames: updated === current ? [] : [TARGET],
    diagnosticsMap,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (
    !inputPath ||
    !outputPath ||
    extra.length ||
    resolve(inputPath) === resolve(outputPath)
  )
    throw new Error(
      'Usage: node patch-workflow-failure-diagnostics.mjs <export.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const workflows = Array.isArray(source) ? source : [source];
  if (workflows.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const { workflow, changedNodeNames, diagnosticsMap } =
    patchWorkflowFailureDiagnostics(workflows[0]);
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [workflow] : workflow, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({ changedNodeNames, diagnosticsMap }) + '\n',
  );
}
