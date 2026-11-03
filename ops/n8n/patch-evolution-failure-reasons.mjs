import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { patchWorkflowFailureDiagnostics } from './patch-workflow-failure-diagnostics.mjs';

const TARGET = 'Preparar workflow.failed (MVP)';
const CONVERTER = 'Evolution - Montar evento WhatsApp (MVP)';
const BASE_MARKER =
  '// OPS-INBOX-ACK-04: allowlisted workflow failure diagnostics.\n';
const BASE_NODE =
  'const workflowFailureNode = $json.execution?.lastNodeExecuted;\n';
const BASE_CODE =
  "code: workflowFailureCodes.get(workflowFailureNode) ?? 'WORKFLOW_FAILED'";
const REASON_CODE =
  "code: workflowFailureReason ?? workflowFailureCodes.get(workflowFailureNode) ?? 'WORKFLOW_FAILED'";
const MARKER =
  '// OPS-INBOX-ACK-05: controlled Evolution converter failure reasons.\n';
const ADDITION =
  MARKER +
  `const workflowFailureMessage = workflowFailureNode === ${JSON.stringify(CONVERTER)} && typeof $json.execution?.error?.message === 'string' ? $json.execution.error.message : '';
const workflowFailureReason = /^EVOLUTION_IDENTITY_UNRESOLVED(?:$|\\s)/u.test(workflowFailureMessage) ? 'EVOLUTION_IDENTITY_UNRESOLVED' : workflowFailureMessage === 'invalid syntax' ? 'N8N_EXPRESSION_SYNTAX' : null;
`;

/** @param {string} code @param {string} expected @param {string} replacement */
function replaceOnce(code, expected, replacement) {
  const parts = code.split(expected);
  if (parts.length !== 2)
    throw new Error('EVOLUTION_FAILURE_REASONS_CONTEXT_MISMATCH');
  return parts[0] + replacement + parts[1];
}

/**
 * OPS-INBOX-ACK-05 / OPS-ERR-04 / ORC-08: classify two evidenced converter
 * failures into fixed enums. No execution messages, stacks or payloads leave
 * the Code node; all other errors retain the existing allowlisted node code.
 * This helper only prepares a reviewed export and never publishes or executes it.
 * @param {any} source
 * @returns {{workflow:any, changedNodeNames:string[]}}
 */
export function patchEvolutionFailureReasons(source) {
  if (!Array.isArray(source?.nodes) || !source.connections)
    throw new Error('WORKFLOW_INVALID');
  const matches = source.nodes.filter(
    (/** @type {any} */ node) => node.name === TARGET,
  );
  const converters = source.nodes.filter(
    (/** @type {any} */ node) => node.name === CONVERTER,
  );
  if (matches.length !== 1 || converters.length !== 1)
    throw new Error('WORKFLOW_NODE_MISSING_OR_AMBIGUOUS');
  const current = matches[0].parameters?.jsCode;
  if (typeof current !== 'string' || !current.startsWith(BASE_MARKER))
    throw new Error('EVOLUTION_FAILURE_REASONS_CONTEXT_MISMATCH');
  let baseline = current;
  if (current.includes(MARKER)) {
    baseline = replaceOnce(current, BASE_NODE + ADDITION, BASE_NODE);
    baseline = replaceOnce(baseline, REASON_CODE, BASE_CODE);
  }
  // Reuse the strict ACK-04 map and node-field guards without changing them.
  const restored = structuredClone(source);
  restored.nodes.find(
    (/** @type {any} */ node) => node.name === TARGET,
  ).parameters.jsCode = baseline;
  if (patchWorkflowFailureDiagnostics(restored).changedNodeNames.length)
    throw new Error('EVOLUTION_FAILURE_REASONS_CONTEXT_MISMATCH');
  let updated = replaceOnce(baseline, BASE_NODE, BASE_NODE + ADDITION);
  updated = replaceOnce(updated, BASE_CODE, REASON_CODE);
  const workflow = structuredClone(source);
  workflow.nodes.find(
    (/** @type {any} */ node) => node.name === TARGET,
  ).parameters.jsCode = updated;
  return { workflow, changedNodeNames: updated === current ? [] : [TARGET] };
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
      'Usage: node patch-evolution-failure-reasons.mjs <export.json> <review.json>',
    );
  const source = JSON.parse(await readFile(inputPath, 'utf8'));
  const workflows = Array.isArray(source) ? source : [source];
  if (workflows.length !== 1) throw new Error('EXPECTED_ONE_WORKFLOW');
  const { workflow, changedNodeNames } = patchEvolutionFailureReasons(
    workflows[0],
  );
  await writeFile(
    outputPath,
    JSON.stringify(Array.isArray(source) ? [workflow] : workflow, null, 2) +
      '\n',
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(JSON.stringify({ changedNodeNames }) + '\n');
}
