import assert from 'node:assert/strict';
import test from 'node:test';

import {
  patchVendedorPrioridades,
  vendedorPriorityHash,
} from '../ops/n8n/patch-vendedor-prioridades.mjs';

const DECISION = 'Normalizar decisão da IA (MVP)';
const AGENT = 'Atendente virtual Silmer (MVP)';
const CODE_KEY = DECISION + '.jsCode';
const PROMPT_KEY = AGENT + '.systemMessage';
const originalCode = [
  '// synthetic canonical decision',
  'const epoch = context.automation_epoch;',
  'const revision = context.source_revision;',
  'const observed = context.order_assistance;',
  'const canReply = context.mode === "ai_active";',
  'const subject = context.target_subject_id;',
  'const briefing = context.briefing;',
  'const missing = context.missing;',
  'const urgent = missing.length === 0 && context.deadline === "tomorrow";',
  'const reason = urgent ? "urgency" : null;',
  'const handoff = Boolean(reason);',
  'const first = 1;',
  'const second = 2;',
  'const third = 3;',
  'const fourth = 4;',
  'const fifth = 5;',
  'const sixth = 6;',
  'const reply = "Synthetic reply";',
  'const payload = { epoch, revision, subject, briefing, handoff };',
  'return { json: { ...payload, reply, observed, canReply } };',
].join('\n');
const changedCode = originalCode
  .replace(
    'const urgent = missing.length === 0 && context.deadline === "tomorrow";',
    '// VND-L05: preserve human commercial decisions.\nconst urgent = context.deadline === "tomorrow";',
  )
  .replace(
    'const reply = "Synthetic reply";',
    'const reply = "Synthetic referral without a promise";',
  );
const originalPrompt =
  'Synthetic introduction.\nThe seller decides commercial terms.\nAsk the next missing field.\nNo automatic order.\nNo customer data in telemetry.';
const changedPrompt = originalPrompt.replace(
  'Ask the next missing field.',
  'Refer blocking feasibility questions to the seller.',
);

/** @param {string} [code] @param {string} [prompt] @returns {any} */
function fixture(code = originalCode, prompt = originalPrompt) {
  return {
    id: 'k7tI6T4RhQPyJkn9',
    active: true,
    versionId: 'synthetic-private-version',
    nodes: [
      {
        id: 'synthetic-decision',
        name: DECISION,
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: code, mode: 'runOnceForEachItem' },
        position: [30, 40],
      },
      {
        id: 'synthetic-agent',
        name: AGENT,
        type: '@n8n/n8n-nodes-langchain.agent',
        parameters: { options: { systemMessage: prompt, maxIterations: 1 } },
        position: [10, 20],
      },
      {
        id: 'synthetic-transport',
        name: 'Evolution - Synthetic transport',
        type: 'n8n-nodes-base.httpRequest',
        parameters: {
          url: 'https://synthetic.invalid',
          headerParameters: {
            parameters: [
              {
                name: 'X-Silmer-Workflow-Version',
                value: 'synthetic-turns-version',
              },
            ],
          },
        },
        credentials: {
          httpBasicAuth: {
            id: 'synthetic-reference',
            name: 'Synthetic reference',
          },
        },
      },
      {
        id: 'synthetic-oa',
        name: 'Synthetic human observation',
        type: 'n8n-nodes-base.code',
        parameters: { jsCode: 'return {json:{open_order:false}};' },
      },
    ],
    connections: {
      [DECISION]: { main: [[{ node: AGENT, type: 'main', index: 0 }]] },
    },
    settings: {
      saveExecutionProgress: false,
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'none',
    },
    pinData: {},
    staticData: { synthetic: true },
    tags: [{ name: 'synthetic' }],
  };
}

/** @param {any} workflow */
function manifest(workflow) {
  return {
    [CODE_KEY]: vendedorPriorityHash(workflow.nodes[0].parameters.jsCode),
    [PROMPT_KEY]: vendedorPriorityHash(
      workflow.nodes[1].parameters.options.systemMessage,
    ),
  };
}

function setup() {
  const before = fixture();
  const after = fixture(changedCode, changedPrompt);
  const live = fixture(
    '// SYNTHETIC telemetry wrapper before\nconst telemetryOutput = (() => {\n' +
      originalCode +
      '\n})();\n// SYNTHETIC telemetry wrapper after\nreturn telemetryOutput;',
    originalPrompt + '\nSynthetic operational instructions stay intact.',
  );
  return { before, after, live, review: manifest(live) };
}

test('VND-L05 patch preserves all live metadata, credentials, transport, OA and telemetry wrappers', () => {
  const { before, after, live, review } = setup();
  const unchanged = structuredClone(live);
  const result = patchVendedorPrioridades(live, before, after, review);
  assert.deepEqual(live, unchanged, 'input is immutable');
  const expected = structuredClone(live);
  expected.nodes[0].parameters.jsCode = live.nodes[0].parameters.jsCode.replace(
    originalCode,
    changedCode,
  );
  expected.nodes[1].parameters.options.systemMessage =
    changedPrompt + '\nSynthetic operational instructions stay intact.';
  assert.deepEqual(result.workflow, expected);
  assert.deepEqual(result.changedFields, [CODE_KEY, PROMPT_KEY]);
  assert.equal(result.plan.published, false);
  assert.equal(result.plan.versionHeadersPreserved, true);
  assert.equal(result.plan.fields[0].hunks, 2);
  assert.equal(result.plan.fields[0].beforeSha256, review[CODE_KEY]);
  assert.equal(
    result.plan.fields[0].afterSha256,
    vendedorPriorityHash(expected.nodes[0].parameters.jsCode),
  );
  assert.doesNotMatch(
    JSON.stringify(result.plan),
    /Synthetic reply|telemetry wrapper|synthetic\.invalid/u,
  );
});

test('VND-L05 patch is idempotent only when exact reverse delta recovers the reviewed bytes', () => {
  const { before, after, live, review } = setup();
  const once = patchVendedorPrioridades(live, before, after, review);
  const twice = patchVendedorPrioridades(once.workflow, before, after, review);
  assert.deepEqual(twice.workflow, once.workflow);
  assert.deepEqual(twice.changedFields, []);
  const drift = structuredClone(once.workflow);
  drift.nodes[0].parameters.jsCode += '\n// unrelated drift';
  assert.throws(
    () => patchVendedorPrioridades(drift, before, after, review),
    /LIVE_CODE_DRIFT/u,
  );
});

test('VND-L05 patch refuses unreviewed input and drift without editing the source', () => {
  const { before, after, live, review } = setup();
  assert.throws(
    () => patchVendedorPrioridades(live, before, after, {}),
    /REVIEW_HASH_REQUIRED/u,
  );
  assert.throws(
    () =>
      patchVendedorPrioridades(live, before, after, {
        ...review,
        unknown: 'a'.repeat(64),
      }),
    /UNKNOWN_FIELD/u,
  );
  const drift = structuredClone(live);
  drift.nodes[0].parameters.jsCode += '\n// changed remotely';
  assert.throws(
    () => patchVendedorPrioridades(drift, before, after, review),
    /HUNK_MISSING_OR_AMBIGUOUS|LIVE_CODE_DRIFT/u,
  );
  const oldShape = structuredClone(live);
  oldShape.nodes[0].parameters.jsCode =
    oldShape.nodes[0].parameters.jsCode.replace(
      'const missing = context.missing;',
      'const missing = [];',
    );
  const untouched = structuredClone(oldShape);
  assert.throws(
    () => patchVendedorPrioridades(oldShape, before, after, manifest(oldShape)),
    /HUNK_MISSING_OR_AMBIGUOUS/u,
  );
  assert.deepEqual(oldShape, untouched);
});

test('VND-L05 patch fails closed on ambiguous hunks, nodes, pinned data and wrong workflow', () => {
  const { before, after, live, review } = setup();
  const ambiguous = structuredClone(live);
  ambiguous.nodes[0].parameters.jsCode += '\n' + originalCode;
  assert.throws(
    () =>
      patchVendedorPrioridades(ambiguous, before, after, manifest(ambiguous)),
    /HUNK_MISSING_OR_AMBIGUOUS/u,
  );
  for (const input of [
    { ...live, id: 'other' },
    { ...live, pinData: { synthetic: [] } },
    { ...live, nodes: [...live.nodes, structuredClone(live.nodes[0])] },
    { ...live, nodes: live.nodes.slice(1) },
  ])
    assert.throws(
      () => patchVendedorPrioridades(input, before, after, review),
      /PRIORITIES_/u,
    );
  const invalid = structuredClone(live);
  invalid.nodes[0].type = 'n8n-nodes-base.httpRequest';
  assert.throws(
    () => patchVendedorPrioridades(invalid, before, after, review),
    /NODE_CONTEXT_MISMATCH/u,
  );
});

test('VND-L05 patch handles an inserted helper and leaves unrelated operational body intact', () => {
  const { before, live } = setup();
  const after = fixture(
    originalCode.replace(
      'const urgent =',
      'const blockingQuestion = false;\nconst urgent =',
    ),
    originalPrompt,
  );
  const review = { [CODE_KEY]: manifest(live)[CODE_KEY] };
  const result = patchVendedorPrioridades(live, before, after, review);
  assert.equal(
    result.workflow.nodes[0].parameters.jsCode,
    live.nodes[0].parameters.jsCode.replace(
      'const urgent =',
      'const blockingQuestion = false;\nconst urgent =',
    ),
  );
  assert.deepEqual(result.changedFields, [CODE_KEY]);
  assert.deepEqual(
    patchVendedorPrioridades(result.workflow, before, after, review).workflow,
    result.workflow,
  );
});

test('VND-L05 patch accepts sanitized canonical metadata while requiring real live identities', () => {
  const { before, after, live, review } = setup();
  for (const canonical of [before, after]) {
    canonical.source = { workflowId: canonical.id };
    delete canonical.id;
    for (const node of canonical.nodes) delete node.id;
  }
  assert.equal(
    patchVendedorPrioridades(live, before, after, review).changedFields.length,
    2,
  );
  const invalidLive = structuredClone(live);
  delete invalidLive.nodes[0].id;
  assert.throws(
    () => patchVendedorPrioridades(invalidLive, before, after, review),
    /NODE_MISSING_OR_AMBIGUOUS/u,
  );
});

test('VND-L05 patch narrows a one-line prompt change without copying the operational prompt', () => {
  const long =
    'Synthetic opening. '.repeat(15) +
    'Ask before collecting.' +
    ' Synthetic ending.'.repeat(15);
  const before = fixture(originalCode, long);
  const after = fixture(
    originalCode,
    long.replace('Ask before collecting.', 'Refer before collecting.'),
  );
  const live = fixture(
    originalCode,
    'Operational prefix. ' + long + ' Operational suffix.',
  );
  const review = {
    [PROMPT_KEY]: vendedorPriorityHash(
      live.nodes[1].parameters.options.systemMessage,
    ),
  };
  const result = patchVendedorPrioridades(live, before, after, review);
  assert.equal(
    result.workflow.nodes[1].parameters.options.systemMessage,
    live.nodes[1].parameters.options.systemMessage.replace(
      'Ask before collecting.',
      'Refer before collecting.',
    ),
  );
});

test('VND-L05 patch compiles the candidate without running code or leaking diagnostics', () => {
  const { before, after, live, review } = setup();
  after.nodes[0].parameters.jsCode = changedCode.replace(
    'const urgent =',
    'const urgent ( =',
  );
  assert.throws(() => patchVendedorPrioridades(live, before, after, review), {
    message: 'PRIORITIES_CODE_SYNTAX_INVALID',
  });
  const executable = setup();
  executable.after.nodes[0].parameters.jsCode = changedCode.replace(
    'const urgent =',
    'throw new Error("synthetic-must-not-run");\nconst urgent =',
  );
  assert.doesNotThrow(() =>
    patchVendedorPrioridades(
      executable.live,
      executable.before,
      executable.after,
      executable.review,
    ),
  );
});
