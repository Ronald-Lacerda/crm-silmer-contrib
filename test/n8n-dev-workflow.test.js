import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createDevTestWorkflow,
  DEV_WORKFLOW_ID,
  DEV_WORKFLOW_VERSION,
} from '../ops/n8n/workflows/create-dev-test-workflow.mjs';

const mainSnapshot = new URL(
  '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
  import.meta.url,
);

/**
 * @param {{deployment?: boolean, local?: boolean}} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function workflow(options) {
  const source = JSON.parse(await readFile(mainSnapshot, 'utf8'));
  return createDevTestWorkflow(source, options);
}

/** The CRM calls carry the workflow identity; Meta media and OpenAI do not. */
function isCrmRequest(/** @type {Record<string, any>} */ node) {
  return (
    node.type === 'n8n-nodes-base.httpRequest' &&
    (node.parameters.headerParameters?.parameters ?? []).some(
      (/** @type {Record<string, any>} */ header) =>
        header.name === 'X-Silmer-Workflow-Key',
    )
  );
}

test('keeps the canonical MVP path while replacing only WhatsApp transport', async () => {
  const dev = await workflow();
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  const names = new Set(nodes.map((node) => node.name));
  const serialized = JSON.stringify(dev);

  assert.equal(dev.source.id, DEV_WORKFLOW_ID);
  assert.equal(dev.source.active, false);
  // Canonical chains exclude all three public site nodes, plus nine DEV nodes.
  // VND-L02 item 5 adds the burst window, the reread and its check.
  // VND-L03 adds the transcript back to the CRM and the failure handoff.
  assert.equal(nodes.length, 121);
  assert.equal(names.has('Site - Receber mensagem do chat (MVP)'), false);
  assert.equal(names.has('Site - Montar evento do chat (MVP)'), false);
  assert.equal(names.has('Site - Direcionar para WhatsApp (MVP)'), false);
  assert.equal(
    Object.keys(dev.connections).some((name) =>
      name.startsWith('Site - Receber'),
    ),
    false,
  );
  assert.equal(
    nodes.some((node) => /whatsApp(?:Trigger)?$/u.test(node.type)),
    false,
  );
  assert.ok(names.has('DEV - Receber evento sintético (MVP)'));
  assert.ok(names.has('DEV - Conversa manual no chat (MVP)'));
  assert.ok(names.has('CRM - Registrar inbound (MVP)'));
  assert.ok(names.has('CRM - Reservar envio da IA (MVP)'));
  assert.ok(names.has('CRM - Registrar message.sent da IA (MVP)'));
  assert.ok(names.has('CRM - Registrar handoff (MVP)'));
  assert.ok(names.has('DEV - Simular aviso de transferência (MVP)'));
  assert.ok(names.has('Painel - Receber comando (MVP)'));
  assert.match(serialized, /simulate_send_unknown/u);
  assert.match(serialized, /loadPreviousSession/u);
  assert.doesNotMatch(serialized, /"(?:credentials|webhookId|pinData)":/u);
});

test('isolates workflow identity, webhook paths and persistence settings', async () => {
  const dev = await workflow();
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  const headers = /** @type {Array<Record<string, any>>} */ (
    nodes
      .filter(isCrmRequest)
      .flatMap((node) => node.parameters.headerParameters.parameters)
  );
  const trigger = nodes.find(
    (node) => node.name === 'DEV - Receber evento sintético (MVP)',
  );
  const panel = nodes.find(
    (node) => node.name === 'Painel - Receber comando (MVP)',
  );

  assert.ok(trigger);
  assert.ok(panel);
  assert.equal(trigger.parameters.path, 'silmer/dev-mvp-flow');
  assert.equal(panel.parameters.path, 'silmer/dev-panel-command');
  assert.equal(dev.settings.saveDataSuccessExecution, 'none');
  assert.equal(dev.settings.saveManualExecutions, false);
  assert.ok(
    headers
      .filter((header) => header.name === 'X-Silmer-Workflow-Key')
      .every((header) => header.value === DEV_WORKFLOW_ID),
  );
  assert.ok(
    headers
      .filter((header) => header.name === 'X-Silmer-Workflow-Version')
      .every((header) => header.value === DEV_WORKFLOW_VERSION),
  );
});

test('keeps test scenarios at the synthetic boundary', async () => {
  const dev = await workflow();
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  const trigger = nodes.find(
    (node) => node.name === 'DEV - Montar evento WhatsApp sintético (MVP)',
  );
  const send = nodes.find(
    (node) => node.name === 'DEV - Simular envio da IA (MVP)',
  );
  assert.ok(trigger);
  assert.ok(send);
  assert.match(
    trigger.parameters.jsCode,
    /'message', 'handoff', 'send_unknown', 'delivery_status'/u,
  );
  assert.match(trigger.parameters.jsCode, /DEV_SCENARIO_INVALID/u);
  assert.match(send.parameters.jsCode, /scenario === 'send_unknown'/u);
  assert.equal(DEV_WORKFLOW_VERSION, 'dev-mvp-simple-18');
  // T16 provenance classifies DEV from the original reservation's version.
  assert.match(DEV_WORKFLOW_VERSION, /^dev-mvp-simple-\d+$/u);
  const result = nodes.find(
    (node) => node.name === 'DEV - Resultado da resposta da IA',
  );
  assert.ok(result);
  assert.match(result.parameters.jsCode, /handoff_ready/u);
  assert.match(result.parameters.jsCode, /missing_briefing_fields/u);
});

test('DEV results show whether the order opened, on the reply and on the handoff (ADR 014)', async () => {
  const dev = await workflow();
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  /** @param {string} name */
  const code = (name) =>
    String(nodes.find((node) => node.name === name)?.parameters.jsCode);
  const reply = code('DEV - Resultado da resposta da IA');
  assert.match(reply, /open_order: decision\.open_order/u);
  assert.match(
    reply,
    /\$\('CRM - Reservar envio da IA \(MVP\)'\)\.item\.json\.order/u,
  );
  assert.doesNotMatch(reply, /order_intent_confirmed/u);
  const handoff = code('DEV - Resultado do handoff');
  assert.match(handoff, /open_order: decision\.open_order/u);
  assert.match(handoff, /order: crm\?\.order/u);
  // The failure check is canonical, so DEV raises ORDER_OPEN_FAILED too.
  assert.ok(nodes.some((node) => node.name === 'Pedido não abriu? (MVP)'));
});

test('manual chat makes CRM session continuity explicit across reloads', async () => {
  const dev = await workflow();
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  const chat = nodes.find(
    (node) => node.name === 'DEV - Conversa manual no chat (MVP)',
  );
  const syntheticInput = nodes.find(
    (node) => node.name === 'DEV - Montar evento WhatsApp sintético (MVP)',
  );

  assert.ok(chat);
  assert.ok(syntheticInput);
  assert.equal(chat.type, '@n8n/n8n-nodes-langchain.chatTrigger');
  assert.equal(chat.parameters.mode, 'hostedChat');
  assert.equal(chat.parameters.authentication, 'n8nUserAuth');
  assert.equal(chat.parameters.requireExecuteAccess, true);
  assert.equal(chat.parameters.options.loadPreviousSession, 'notSupported');
  assert.equal(chat.parameters.options.responseMode, 'lastNode');
  assert.match(
    chat.parameters.initialMessages,
    /mesma conversa continua no CRM/u,
  );
  assert.match(chat.parameters.options.subtitle, /conversa continua no CRM/u);
  assert.equal(chat.parameters.options.getStarted, 'Continuar sessão de teste');
  assert.doesNotMatch(
    chat.parameters.initialMessages,
    /recarregar.*nova conversa/u,
  );
  assert.deepEqual(dev.connections[chat.name].main[0][0], {
    node: 'DEV - Montar evento WhatsApp sintético (MVP)',
    type: 'main',
    index: 0,
  });
  assert.match(syntheticInput.parameters.jsCode, /chatInput/u);
  assert.match(syntheticInput.parameters.jsCode, /syntheticWaId/u);
  assert.match(syntheticInput.parameters.jsCode, /'55419'/u);
  assert.match(syntheticInput.parameters.jsCode, /padStart\(8, '0'\)/u);
});

test('adds only named Basic credential references for deployment output', async () => {
  const dev = await workflow({ deployment: true });
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  const requests = nodes.filter(isCrmRequest);
  // Meta media and OpenAI never get the CRM Basic credential.
  assert.ok(
    nodes
      .filter(
        (node) =>
          node.type === 'n8n-nodes-base.httpRequest' && !isCrmRequest(node),
      )
      .every((node) => node.credentials?.httpBasicAuth === undefined),
  );
  const panel = nodes.find(
    (node) => node.name === 'Painel - Receber comando (MVP)',
  );

  assert.ok(panel);
  assert.ok(
    requests.every(
      (node) =>
        node.credentials.httpBasicAuth.name === 'Silmer n8n para CRM Basic DEV',
    ),
  );
  assert.equal(
    panel.credentials.httpBasicAuth.name,
    'Silmer CRM para n8n Basic DEV',
  );
});

test('makes a localhost-only workflow self-contained without exporting credentials', async () => {
  const local = await workflow({ local: true });
  const nodes = /** @type {Array<Record<string, any>>} */ (local.nodes);
  const requests = nodes.filter(isCrmRequest);
  const panel = nodes.find(
    (node) => node.name === 'Painel - Receber comando (MVP)',
  );
  const trigger = nodes.find(
    (node) => node.name === 'DEV - Receber evento sintético (MVP)',
  );

  assert.ok(panel);
  assert.ok(trigger);
  assert.equal(local.name, 'LOCAL | Silmer | Fluxo completo sem WhatsApp');
  assert.equal(trigger.parameters.path, 'silmer/local-mvp-flow');
  assert.equal(panel.parameters.path, 'silmer/local-panel-command');
  assert.equal(panel.parameters.authentication, 'none');
  assert.ok(
    requests.every(
      (node) =>
        node.parameters.authentication === 'none' &&
        /** @type {Array<Record<string, any>>} */ (
          node.parameters.headerParameters.parameters
        ).some(
          (header) =>
            header.name === 'Authorization' &&
            header.value ===
              '={{ $env.SILMER_LOCAL_N8N_TO_CRM_AUTHORIZATION }}',
        ) &&
        node.credentials === undefined,
    ),
  );
});

test('T14/MED-21: DEV replaces only media Meta effects after real download/hash and before real preflight', async () => {
  const dev = await workflow({ local: true });
  const nodes = /** @type {Array<Record<string, any>>} */ (dev.nodes);
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const download = byName.get('CRM - Baixar midia reservada (MVP)');
  const hash = byName.get('Crypto - SHA256 midia (MVP)');
  const upload = byName.get('DEV - Simular upload Meta de midia (MVP)');
  const preflight = byName.get('CRM - Preflight midia reservada (MVP)');
  const send = byName.get('DEV - Simular envio Meta de midia (MVP)');
  assert.equal(download?.type, 'n8n-nodes-base.httpRequest');
  assert.equal(hash?.type, 'n8n-nodes-base.crypto');
  assert.equal(preflight?.type, 'n8n-nodes-base.httpRequest');
  assert.equal(upload?.type, 'n8n-nodes-base.code');
  assert.equal(send?.type, 'n8n-nodes-base.code');
  assert.match(upload.parameters.jsCode, /getBinaryDataBuffer/u);
  assert.match(send.parameters.jsCode, /simulate_send_unknown/u);
  assert.deepEqual(dev.connections[upload.name].main[0], [
    { node: preflight.name, type: 'main', index: 0 },
  ]);
  // ADR 026 adds read-only inbound Meta media; outbound Meta effects remain simulated.
  const metaRequests = nodes.filter((node) =>
    node.parameters?.url?.includes('graph.facebook.com'),
  );
  assert.equal(metaRequests.length, 2);
  assert.equal(metaRequests[0].name, 'WhatsApp - Consultar mídia (MVP)');
  assert.equal(metaRequests[1].name, 'WhatsApp - Consultar áudio interno (OA)');
  assert.equal(metaRequests[0].parameters.method, 'GET');
  assert.equal(
    nodes.some((node) => node.credentials?.whatsAppApi),
    false,
  );
});
