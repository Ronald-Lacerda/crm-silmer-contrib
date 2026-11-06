import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const WORKFLOW = 'k7tI6T4RhQPyJkn9';
const FIELDS = [
  {
    node: 'Normalizar decisão da IA (MVP)',
    field: 'jsCode',
    type: 'n8n-nodes-base.code',
  },
  {
    node: 'Atendente virtual Silmer (MVP)',
    field: 'systemMessage',
    type: '@n8n/n8n-nodes-langchain.agent',
  },
];

/** Hash exact reviewed bytes, including their line endings. @param {string} value */
export const vendedorPriorityHash = (value) =>
  createHash('sha256').update(value).digest('hex');

/** @param {any} workflow @param {boolean} [canonical] */
function validateWorkflow(workflow, canonical = false) {
  const identifier = canonical
    ? (workflow?.id ?? workflow?.source?.workflowId)
    : workflow?.id;
  if (
    identifier !== WORKFLOW ||
    !Array.isArray(workflow.nodes) ||
    !workflow.connections ||
    !workflow.settings
  )
    throw new Error('PRIORITIES_WORKFLOW_INVALID');
  if (Object.keys(workflow.pinData ?? {}).length)
    throw new Error('PRIORITIES_PINNED_DATA_NOT_ALLOWED');
  for (const key of canonical ? ['name'] : ['name', 'id']) {
    const values = workflow.nodes.map((/** @type {any} */ node) => node[key]);
    if (
      values.some(
        (/** @type {any} */ value) => typeof value !== 'string' || !value,
      ) ||
      new Set(values).size !== values.length
    )
      throw new Error('PRIORITIES_NODE_MISSING_OR_AMBIGUOUS');
  }
}

/** @param {any} workflow @param {{node:string,field:string,type:string}} target */
function readTarget(workflow, target) {
  const node = workflow.nodes.find(
    (/** @type {any} */ item) => item.name === target.node,
  );
  if (!node || node.type !== target.type)
    throw new Error('PRIORITIES_NODE_CONTEXT_MISMATCH: ' + target.node);
  const value =
    target.field === 'jsCode'
      ? node.parameters?.jsCode
      : node.parameters?.options?.systemMessage;
  if (typeof value !== 'string' || !value)
    throw new Error('PRIORITIES_FIELD_INVALID: ' + target.node);
  return { node, value };
}

/** Build small exact replacements with three unchanged lines on each side.
 * No fuzzy matching: an older operational body must contain each reviewed hunk.
 * @param {string} before @param {string} after
 */
function changedHunks(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000)
    throw new Error('PRIORITIES_DIFF_TOO_LARGE');
  const lengths = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i][j] =
        a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  /** @type {Array<{ai:number,az:number,bi:number,bz:number}>} */
  const changes = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const ai = i;
    const bj = j;
    while (
      (i < a.length || j < b.length) &&
      !(i < a.length && j < b.length && a[i] === b[j])
    ) {
      if (
        i < a.length &&
        (j === b.length || lengths[i + 1][j] >= lengths[i][j + 1])
      )
        i++;
      else j++;
    }
    const lead = Math.min(3, ai, bj);
    const tail = Math.min(3, a.length - i, b.length - j);
    const change = { ai: ai - lead, az: i + tail, bi: bj - lead, bz: j + tail };
    const last = changes.at(-1);
    if (last && change.ai <= last.az && change.bi <= last.bz) {
      last.az = change.az;
      last.bz = change.bz;
    } else changes.push(change);
  }
  return changes.map((change) => {
    let oldText = a.slice(change.ai, change.az).join('\n');
    let newText = b.slice(change.bi, change.bz).join('\n');
    // A prompt can be one long paragraph. Keep a bounded common character
    // context instead of requiring the whole paragraph to match production.
    if (!oldText.includes('\n') && !newText.includes('\n')) {
      let prefix = 0;
      while (
        prefix < oldText.length &&
        prefix < newText.length &&
        oldText[prefix] === newText[prefix]
      )
        prefix++;
      let suffix = 0;
      while (
        suffix < oldText.length - prefix &&
        suffix < newText.length - prefix &&
        oldText[oldText.length - 1 - suffix] ===
          newText[newText.length - 1 - suffix]
      )
        suffix++;
      const start = Math.max(0, prefix - 80);
      oldText = oldText.slice(start, oldText.length - Math.max(0, suffix - 80));
      newText = newText.slice(start, newText.length - Math.max(0, suffix - 80));
    }
    if (!oldText || !newText) throw new Error('PRIORITIES_UNANCHORED_CHANGE');
    return { before: oldText, after: newText };
  });
}

/** @param {string} value @param {Array<{before:string,after:string}>} hunks @param {boolean} reverse */
function applyHunks(value, hunks, reverse = false) {
  let result = value;
  for (const hunk of reverse ? [...hunks].reverse() : hunks) {
    const from = reverse ? hunk.after : hunk.before;
    const to = reverse ? hunk.before : hunk.after;
    const start = result.indexOf(from);
    if (start < 0 || result.indexOf(from, start + 1) >= 0)
      throw new Error('PRIORITIES_HUNK_MISSING_OR_AMBIGUOUS');
    result = result.slice(0, start) + to + result.slice(start + from.length);
  }
  return result;
}

/** Prepare the explicitly reviewed VND-L05 delta offline. No execution,
 * import or publication; unrelated living code and telemetry wrappers survive.
 * Manifest keys are `<node name>.<field>`, values exact SHA256 of the reviewed
 * live field BEFORE this patch. Never auto-approve hashes from an export.
 * @param {any} source @param {any} canonicalBefore @param {any} canonicalAfter
 * @param {Record<string,string>} reviewedLiveHashes
 */
export function patchVendedorPrioridades(
  source,
  canonicalBefore,
  canonicalAfter,
  reviewedLiveHashes,
) {
  validateWorkflow(source);
  validateWorkflow(canonicalBefore, true);
  validateWorkflow(canonicalAfter, true);
  if (
    !reviewedLiveHashes ||
    typeof reviewedLiveHashes !== 'object' ||
    Array.isArray(reviewedLiveHashes)
  )
    throw new Error('PRIORITIES_REVIEW_MANIFEST_REQUIRED');
  const workflow = structuredClone(source);
  const changedFields = [];
  /** @type {Array<{key:string,beforeSha256:string,afterSha256:string,hunks:number}>} */
  const reviewedFields = [];
  for (const target of FIELDS) {
    const before = readTarget(canonicalBefore, target).value;
    const after = readTarget(canonicalAfter, target).value;
    if (before === after) continue;
    const key = target.node + '.' + target.field;
    const reviewedHash = reviewedLiveHashes[key];
    if (!/^[a-f0-9]{64}$/u.test(reviewedHash ?? ''))
      throw new Error('PRIORITIES_REVIEW_HASH_REQUIRED: ' + key);
    const live = readTarget(workflow, target);
    const hunks = changedHunks(before, after);
    let patched;
    if (vendedorPriorityHash(live.value) === reviewedHash)
      patched = applyHunks(live.value, hunks);
    else {
      // Reapplication is accepted only when undoing precisely this delta
      // recovers the same explicitly reviewed operational bytes.
      const restored = applyHunks(live.value, hunks, true);
      if (vendedorPriorityHash(restored) !== reviewedHash)
        throw new Error('PRIORITIES_LIVE_CODE_DRIFT: ' + key);
      patched = live.value;
    }
    if (target.field === 'jsCode') {
      try {
        // Compile only. Never execute an exported workflow or its input data.
        new vm.Script('(function () {\n' + patched + '\n})');
      } catch {
        throw new Error('PRIORITIES_CODE_SYNTAX_INVALID');
      }
    }
    if (patched !== live.value) {
      if (target.field === 'jsCode') live.node.parameters.jsCode = patched;
      else live.node.parameters.options.systemMessage = patched;
      changedFields.push(key);
    }
    reviewedFields.push({
      key,
      beforeSha256: reviewedHash,
      afterSha256: vendedorPriorityHash(patched),
      hunks: hunks.length,
    });
  }
  if (!reviewedFields.length) throw new Error('PRIORITIES_EMPTY_DELTA');
  if (
    Object.keys(reviewedLiveHashes).some(
      (key) => !reviewedFields.some((field) => field.key === key),
    )
  )
    throw new Error('PRIORITIES_REVIEW_MANIFEST_UNKNOWN_FIELD');
  return {
    workflow,
    changedFields,
    plan: {
      task: 'VND-L05',
      published: false,
      versionHeadersPreserved: true,
      fields: reviewedFields,
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [livePath, beforePath, afterPath, manifestPath, outputPath, ...extra] =
    process.argv.slice(2);
  if (
    !livePath ||
    !beforePath ||
    !afterPath ||
    !manifestPath ||
    !outputPath ||
    extra.length ||
    [livePath, beforePath, afterPath, manifestPath].some(
      (path) => resolve(path) === resolve(outputPath),
    )
  )
    throw new Error(
      'Five distinct input/output paths required: live before after reviewed-manifest candidate',
    );
  const [live, before, after, manifest] = await Promise.all(
    [livePath, beforePath, afterPath, manifestPath].map(async (path) =>
      JSON.parse(await readFile(path, 'utf8')),
    ),
  );
  const result = patchVendedorPrioridades(live, before, after, manifest);
  await writeFile(outputPath, JSON.stringify(result.workflow, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  process.stdout.write(
    JSON.stringify({ changedFields: result.changedFields, ...result.plan }) +
      '\n',
  );
}
