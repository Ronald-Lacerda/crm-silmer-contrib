import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  patchTurnTelemetry,
  turnCodeHash,
  TURN_TELEMETRY_VERSION,
} from '../ops/n8n/patch-turn-telemetry.mjs';
import { createN8nIntegrationService } from '../modules/n8n-integration/src/index.js';

const INBOUND = 'Preparar inbound CRM (MVP)';
const CONTEXT = 'Montar contexto da IA (MVP)';
const DECISION = 'Normalizar decisão da IA (MVP)';
const RESERVE = 'Preparar reserva de envio da IA (MVP)';
const HANDOFF = 'Preparar handoff da IA (MVP)';
const CONTENT = 'Preparar handoff de conteúdo (MVP)';
const MODEL = 'OpenAI - Modelo do MVP';

/** @returns {any} */
function fixture() {
  const programs = {
    [INBOUND]:
      'return { json: { payload: $json, idempotency_key: "synthetic-inbound" } };',
    [CONTEXT]:
      'return { json: { ...$json, guardrail_version: "synthetic-guard", next_point: "colors" } };',
    [DECISION]:
      'return { json: { ...$json, reply_text: "Qual a cor?", ficha_filled: 3, ficha_total: 9, answer_status: "answered", trigger: null, briefing_patch: { colors: "azul", next_required_field: "quantity" }, open_order: false } };',
    [RESERVE]: `return { json: { payload: {
      schema_version: '1.0', event_id: 'reserve:synthetic', event_type: 'message.send.requested',
      occurred_at: '2026-11-04T03:00:00.000Z', conversation_id: 'conversation-synthetic', automation_epoch: 1,
      source_revision: 2, command_id: 'synthetic-command', target_contract: 'subject-v1',
      subject_id: 'subject-synthetic', order_id: '11111111-1111-4111-8111-111111111111',
      message: {type: 'text', text: $json.reply_text}, briefing_patch: $json.briefing_patch, open_order: false
    }, idempotency_key: 'reserve:synthetic' } };`,
    [HANDOFF]: `return { json: { payload: {
      schema_version: '1.0', event_id: 'handoff:synthetic', event_type: 'handoff.requested',
      occurred_at: '2026-11-04T03:00:00.000Z', conversation_id: 'conversation-synthetic', automation_epoch: 1,
      source_revision: 2, target_contract: 'subject-v1', handoff: {reason:'human_requested'}, open_order:false
    }, idempotency_key: 'handoff:synthetic' } };`,
    [CONTENT]:
      'return { json: { payload: { event_type: "handoff.requested", handoff: { reason: "unsupported" }, open_order: false }, idempotency_key: "content:synthetic" } };',
  };
  const nodes = Object.entries(programs).map(([name, jsCode]) => ({
    id: 'synthetic-' + name,
    name,
    type: 'n8n-nodes-base.code',
    parameters: { jsCode },
  }));
  return {
    id: 'k7tI6T4RhQPyJkn9',
    active: true,
    nodes: [
      ...nodes,
      {
        id: 'model',
        name: MODEL,
        type: 'synthetic-model',
        parameters: { model: { value: 'synthetic-model-v1' } },
        credentials: { openAiApi: { id: 'synthetic-private-reference' } },
      },
      {
        id: 'crm',
        name: 'CRM - Reservar envio da IA (MVP)',
        parameters: {
          headerParameters: {
            parameters: [
              {
                name: 'X-Silmer-Workflow-Version',
                value: 'evolution-baileys-1',
              },
            ],
          },
        },
      },
      {
        id: 'crm-handoff',
        name: 'CRM - Registrar handoff (MVP)',
        parameters: {
          headerParameters: {
            parameters: [
              {
                name: 'X-Silmer-Workflow-Version',
                value: 'evolution-baileys-1',
              },
            ],
          },
        },
      },
    ],
    settings: {
      saveDataSuccessExecution: 'none',
      saveDataErrorExecution: 'none',
      executionTimeout: 180,
    },
    connections: {
      [INBOUND]: { main: [[{ node: CONTEXT, type: 'main', index: 0 }]] },
    },
    pinData: {},
  };
}

/** @param {any} source */
function reviewed(source) {
  return {
    reviewedCodeHashes: Object.fromEntries(
      source.nodes
        .filter((/** @type {any} */ n) => n.type === 'n8n-nodes-base.code')
        .map((/** @type {any} */ n) => [
          n.name,
          turnCodeHash(n.parameters.jsCode),
        ]),
    ),
  };
}

/** @param {any} workflow @param {string} name @param {any} input @param {Record<string,any>} upstream */
function run(workflow, name, input, upstream) {
  const result = vm.runInNewContext(
    `(() => {\n${workflow.nodes.find((/** @type {any} */ n) => n.name === name).parameters.jsCode}\n})()`,
    {
      $json: input,
      $: (/** @type {string} */ key) => {
        if (!(key in upstream)) throw new Error('synthetic upstream not run');
        return { item: { json: upstream[key] } };
      },
    },
  );
  return JSON.parse(JSON.stringify(result));
}

/** @param {boolean} [capable] */
function round(capable = true) {
  const source = fixture();
  const workflow = patchTurnTelemetry(source, reviewed(source)).workflow;
  const upstream = {
    'Normalizar evento WhatsApp (MVP)': {
      message_type: 'text',
      text: 'Mensagem sintética',
    },
  };
  const input = {
    source_revision: 2,
    automation_epoch: 1,
    ...(capable ? { contact_context: null } : {}),
  };
  const prepared = run(workflow, INBOUND, input, upstream);
  const context = run(workflow, CONTEXT, input, {
    ...upstream,
    [INBOUND]: prepared.json,
    'CRM - Registrar inbound (MVP)': input,
  });
  const decision = run(workflow, DECISION, context.json, upstream);
  return {
    source,
    workflow,
    prepared,
    decision,
    upstream: {
      ...upstream,
      [INBOUND]: prepared.json,
      'CRM - Registrar inbound (MVP)': input,
    },
  };
}

test('AGENTE-OBS-03: a complete round records strict telemetry with the actual model and preserves commands', async () => {
  const r = round();
  const event = run(r.workflow, RESERVE, r.decision.json, r.upstream);
  const original = run(r.source, RESERVE, r.decision.json, r.upstream);
  const { turn, ...payload } = event.json.payload;
  assert.deepEqual(payload, original.json.payload);
  assert.equal(event.json.idempotency_key, original.json.idempotency_key);
  assert.equal(turn.model, 'synthetic-model-v1');
  assert.equal(turn.asked_field, 'quantity');
  assert.equal(turn.ficha_filled, 3);
  assert.equal(turn.ficha_total, 9);
  assert.equal(turn.media_kind, 'text');
  assert.ok(turn.latency_ms >= 0);
  assert.deepEqual(Object.keys(turn).sort(), [
    'answer_status',
    'asked_field',
    'ficha_filled',
    'ficha_total',
    'latency_ms',
    'media_kind',
    'model',
    'trigger',
  ]);
  const recorded = /** @type {any[]} */ ([]);
  const service = createN8nIntegrationService({
    repository: {
      receiveInbound: async () => ({}),
      storeAttachment: async () => ({}),
      recordEvent: async (/** @type {any} */ input) => {
        recorded.push(input);
        return { accepted: true };
      },
    },
  });
  await service.recordEvent({
    ...event.json.payload,
    technical: {
      actor: 'AUTOMATION_EXECUTOR',
      correlationId: 'synthetic-correlation',
      credentialVersion: 'current',
      executionId: 'synthetic-execution',
      idempotencyKey: event.json.idempotency_key,
      requestId: 'synthetic-request',
      workflowKey: 'whatsapp-mvp',
      workflowVersion: TURN_TELEMETRY_VERSION,
    },
  });
  assert.equal(recorded[0].turn.model, 'synthetic-model-v1');
  assert.equal(recorded[0].technical.workflowVersion, TURN_TELEMETRY_VERSION);
});

test('AGENTE-OBS-03: old CRM and missing receipt keep telemetry optional', () => {
  const old = round(false);
  assert.equal(
    run(old.workflow, RESERVE, old.decision.json, old.upstream).json.payload
      .turn,
    undefined,
  );
  const r = round();
  delete r.decision.json.turn_started_at;
  assert.equal(
    run(r.workflow, RESERVE, r.decision.json, r.upstream).json.payload.turn,
    undefined,
  );
});

test('AGENTE-OBS-03: human and content handoffs have telemetry without changing reasons or inventing ficha', () => {
  const r = round();
  const handoff = run(
    r.workflow,
    HANDOFF,
    { ...r.decision.json, asked_point: null, trigger: 'human_requested' },
    r.upstream,
  ).json.payload;
  assert.equal(handoff.turn.trigger, 'human_requested');
  assert.equal(handoff.turn.asked_field, null);
  assert.equal(handoff.handoff.reason, 'human_requested');
  const content = run(
    r.workflow,
    CONTENT,
    r.upstream['CRM - Registrar inbound (MVP)'],
    r.upstream,
  ).json.payload;
  assert.equal(content.turn.model, null);
  assert.equal(content.turn.ficha_total, 0);
  assert.equal(content.turn.trigger, 'unsupported_content');
  assert.equal(content.handoff.reason, 'unsupported');
  assert.equal(content.open_order, false);
});

test('AGENTE-OBS-03: patch is idempotent and preserves nodes, credentials, guards, connections and settings', () => {
  const source = fixture();
  const before = structuredClone(source);
  const options = reviewed(source);
  const result = patchTurnTelemetry(source, options);
  assert.deepEqual(source, before);
  assert.equal(result.changedNodeNames.length, 6);
  assert.deepEqual(result.workflow.connections, source.connections);
  assert.deepEqual(result.workflow.settings, source.settings);
  assert.deepEqual(
    result.workflow.nodes.find((/** @type {any} */ n) => n.name === MODEL),
    source.nodes.find((/** @type {any} */ n) => n.name === MODEL),
  );
  const twice = patchTurnTelemetry(result.workflow, options);
  assert.deepEqual(twice.workflow, result.workflow);
  assert.deepEqual(twice.changedNodeNames, []);
});

test('AGENTE-OBS-03: refuses unreviewed original or overlay drift, partial topology, pinned data and wrong target', () => {
  const source = fixture();
  const options = reviewed(source);
  assert.throws(() => patchTurnTelemetry(source), /CODE_DRIFT/u);
  const drift = structuredClone(source);
  drift.nodes[0].parameters.jsCode += '\n// unreviewed';
  assert.throws(() => patchTurnTelemetry(drift, options), /CODE_DRIFT/u);
  const patched = patchTurnTelemetry(source, options).workflow;
  patched.nodes[0].parameters.jsCode += '\n// unreviewed';
  assert.throws(() => patchTurnTelemetry(patched, options), /OVERLAY_DRIFT/u);
  assert.throws(
    () =>
      patchTurnTelemetry({ ...source, nodes: source.nodes.slice(1) }, options),
    /NODE_MISSING/u,
  );
  assert.throws(
    () =>
      patchTurnTelemetry({ ...source, pinData: { synthetic: [] } }, options),
    /PINNED_DATA/u,
  );
  assert.throws(
    () => patchTurnTelemetry({ ...source, id: 'other' }, options),
    /WORKFLOW_INVALID/u,
  );
});

test('AGENTE-OBS-03: refuses model values rejected by the API and missing or duplicate version headers', () => {
  for (const model of ['Uppercase', 'model:tag', 'a'.repeat(65)]) {
    const source = fixture();
    source.nodes.find(
      (/** @type {any} */ n) => n.name === MODEL,
    ).parameters.model.value = model;
    assert.throws(
      () => patchTurnTelemetry(source, reviewed(source)),
      /MODEL_INVALID/u,
    );
  }
  for (const duplicate of [false, true]) {
    const source = fixture();
    const headers = source.nodes.find(
      (/** @type {any} */ n) => n.name === 'CRM - Registrar handoff (MVP)',
    ).parameters.headerParameters.parameters;
    if (duplicate) headers.push(structuredClone(headers[0]));
    else headers.length = 0;
    assert.throws(
      () => patchTurnTelemetry(source, reviewed(source)),
      /VERSION_HEADER_MISSING_OR_AMBIGUOUS/u,
    );
  }
});
