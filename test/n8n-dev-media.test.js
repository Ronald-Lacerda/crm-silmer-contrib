import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDevTestWorkflow } from '../ops/n8n/workflows/create-dev-test-workflow.mjs';
import { prepareLocalWorkflow } from '../ops/n8n/import-local-workflow.mjs';
test('T15/MED-23: importer assigns native node IDs once and preserves them by name across SDK regeneration', () => {
  const incoming = {
    id: 'workflow',
    active: false,
    nodes: [{ name: 'Measure', type: 'n8n-nodes-base.code' }],
  };
  const initial = prepareLocalWorkflow(incoming, null);
  assert.match(initial.nodes[0].id, /^[a-f0-9-]{36}$/u);
  assert.equal(
    prepareLocalWorkflow(incoming, initial).nodes[0].id,
    initial.nodes[0].id,
  );
  assert.equal(Reflect.get(incoming.nodes[0], 'id'), undefined);
});
const source = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
test('T15/MED-23: localhost technical webhook accepts the real Node client user agent', () => {
  const local = createDevTestWorkflow(source, { local: true });
  const panel = local.nodes.find(
    (/** @type {any} */ node) => node.name === 'Painel - Receber comando (MVP)',
  );
  assert.equal(panel.parameters.authentication, 'none');
  assert.equal(panel.parameters.options.ignoreBots, false);
});
test('T15/MED-23: canonical and deployed technical webhook preserve Basic while accepting Node command workers', () => {
  for (const workflow of [
    source,
    createDevTestWorkflow(source, { deployment: true }),
  ]) {
    const panel = workflow.nodes.find(
      (/** @type {any} */ node) =>
        node.name === 'Painel - Receber comando (MVP)',
    );
    assert.equal(panel.parameters.options.ignoreBots, false);
    assert.equal(panel.parameters.authentication, 'basicAuth');
  }
  const deployment = createDevTestWorkflow(source, { deployment: true });
  assert.equal(
    deployment.nodes.find(
      (/** @type {any} */ node) =>
        node.name === 'Painel - Receber comando (MVP)',
    ).credentials.httpBasicAuth.name,
    'Silmer CRM para n8n Basic DEV',
  );
});
/** @param {string} name @param {number} size @param {any} flags */
function simulate(name, size, flags) {
  const dev = createDevTestWorkflow(source, { local: true });
  const node = dev.nodes.find((/** @type {any} */ row) => row.name === name);
  return vm.runInNewContext(
    `(async function(){${node.parameters.jsCode}}).call(ctx)`,
    {
      ctx: { helpers: { getBinaryDataBuffer: async () => Buffer.alloc(size) } },
      $itemIndex: 0,
      $: (/** @type {string} */ key) => ({
        item: {
          json: key.startsWith('Painel')
            ? { body: flags }
            : {
                command: {
                  command_id: 'synthetic',
                  message: { size_bytes: 3 },
                },
              },
        },
      }),
    },
  );
}
test('T15/MED-21/23: DEV upload validates actual buffer and can exercise known pre-message failure', async () => {
  const name = 'DEV - Simular upload Meta de midia (MVP)';
  assert.equal((await simulate(name, 3, {})).json.simulated, true);
  await assert.rejects(simulate(name, 2, {}), /DEV_MEDIA_UPLOAD_INVALID/u);
  await assert.rejects(
    simulate(name, 3, { simulate_media_upload_failed: true }),
    /DEV_MEDIA_UPLOAD_FAILED/u,
  );
});
test('T15/MED-24: DEV message uncertainty throws after effect boundary with no external HTTP', async () => {
  const name = 'DEV - Simular envio Meta de midia (MVP)';
  assert.equal(
    (await simulate(name, 3, {})).json.messages[0].id,
    'dev-human-media-synthetic',
  );
  await assert.rejects(
    simulate(name, 3, { simulate_send_unknown: true }),
    /DEV_SIMULATED_SEND_OUTCOME_UNKNOWN/u,
  );
});
for (const local of [false, true])
  test(`T15/MED-20/23: local=${local} saves neither bytes nor execution data`, () => {
    const dev = createDevTestWorkflow(source, { local });
    assert.deepEqual(
      [
        dev.settings.saveDataSuccessExecution,
        dev.settings.saveDataErrorExecution,
        dev.settings.saveExecutionProgress,
        dev.settings.saveManualExecutions,
      ],
      ['none', 'none', false, false],
    );
    // VND-L02 item 5: the only wait is the burst window, a timed wait under
    // 65 seconds that n8n keeps in memory, so it offloads no execution data.
    const waits = dev.nodes.filter(
      (/** @type {any} */ n) => n.type === 'n8n-nodes-base.wait',
    );
    assert.deepEqual(
      waits.map((/** @type {any} */ n) => n.name),
      ['Aguardar mensagens seguidas (MVP)'],
    );
    for (const wait of waits) {
      assert.equal(wait.parameters.resume, 'timeInterval');
      assert.equal(wait.parameters.unit, 'seconds');
      assert.ok(wait.parameters.amount > 0 && wait.parameters.amount < 65);
    }
    assert.equal(dev.pinData, undefined);
    assert.equal(dev.staticData, undefined);
  });
test('T15/MED-20: digest import preserves local OpenAI credential and publication state, never CRM or Meta credentials', () => {
  const incoming = {
    id: 'workflow',
    active: false,
    nodes: [
      { id: 'ai', name: 'AI', type: '@n8n/n8n-nodes-langchain.lmChatOpenAi' },
      { id: 'crm', name: 'CRM', type: 'n8n-nodes-base.httpRequest' },
    ],
  };
  const existing = {
    id: 'workflow',
    active: true,
    nodes: [
      {
        id: 'ai',
        name: 'AI',
        type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
        credentials: { openAiApi: { id: 'local-reference', name: 'Local' } },
      },
      {
        id: 'crm',
        name: 'CRM',
        type: 'n8n-nodes-base.httpRequest',
        credentials: { httpBasicAuth: { id: 'old-private' } },
      },
    ],
  };
  const result = prepareLocalWorkflow(incoming, existing);
  assert.deepEqual(result.nodes[0].credentials, existing.nodes[0].credentials);
  assert.equal(result.nodes[1].credentials, undefined);
  assert.equal(result.active, true);
  assert.equal(incoming.active, false);
  assert.equal(JSON.stringify(result).includes('old-private'), false);
});
test('T15/MED-23: local instance explicitly uses native default binary mode and bounded resources', async () => {
  const compose = await readFile(
    new URL('../docker-compose.dev.yml', import.meta.url),
    'utf8',
  );
  assert.match(compose, /N8N_DEFAULT_BINARY_DATA_MODE: .default./u);
  assert.match(compose, /N8N_CONCURRENCY_PRODUCTION_LIMIT: .1./u);
  assert.match(compose, /mem_limit: 2g/u);
  assert.match(compose, /import-local-workflow.mjs/u);
  assert.doesNotMatch(compose, /touch .*marker/u);
});
for (const local of [false, true])
  test(`T15/MED-23: regenerated local=${local} snapshot preserves actual media path`, async () => {
    const snapshot = JSON.parse(
      await readFile(
        new URL(
          local
            ? '../ops/n8n/workflows/0S5ZS1xeDCSoWovs-local-test.sanitized.json'
            : '../ops/n8n/workflows/0S5ZS1xeDCSoWovs-dev-test.sanitized.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.deepEqual(snapshot, createDevTestWorkflow(source, { local }));
    // ADR 026 inbound reading adds nodes; outbound seller transports stay simulated.
    // VND-L02 item 5 adds the burst window, the reread and its check.
    // VND-L03 adds the transcript back to the CRM and the failure handoff.
    assert.equal(snapshot.nodes.length, 121);
    const metaRequests = snapshot.nodes.filter((/** @type {any} */ node) =>
      node.parameters?.url?.includes('graph.facebook.com'),
    );
    assert.equal(metaRequests.length, 2);
    assert.equal(metaRequests[0].name, 'WhatsApp - Consultar mídia (MVP)');
    assert.equal(
      metaRequests[1].name,
      'WhatsApp - Consultar áudio interno (OA)',
    );
    assert.equal(metaRequests[0].parameters.method, 'GET');
  });
