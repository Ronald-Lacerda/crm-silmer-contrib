import { patchBillingSendPreflight } from '../billing-send-preflight.mjs';
import { createDevTestWorkflow } from './create-dev-test-workflow.mjs';

const TRIGGER = 'Painel - Receber comando (MVP)';
const SEND = 'DEV - Simular envio humano (MVP)';
const SENT = 'CRM - Registrar message.sent humano (MVP)';
const ACK = 'Responder comando aceito (MVP)';
const edge = (/** @type {string} */ node) => ({ node, type: 'main', index: 0 });

/** Derive only the human command branch. The reservation, final billing
 * preflight and result callbacks remain the canonical workflow implementation.
 * No provider URL, AI node, account credential or production workflow is used.
 * @param {Record<string,any>} canonical */
export function createBillingDevelopmentTransportWorkflow(canonical) {
  const patched = patchBillingSendPreflight(canonical).workflow;
  const workflow = createDevTestWorkflow(patched, { local: true });
  const reachable = new Set();
  function visit(/** @type {string} */ name) {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const groups of Object.values(workflow.connections[name] ?? {}))
      for (const group of /** @type {any[]} */ (groups))
        for (const connection of group) visit(connection.node);
  }
  visit(TRIGGER);
  workflow.nodes = workflow.nodes.filter((/** @type {any} */ node) =>
    reachable.has(node.name),
  );
  workflow.connections = Object.fromEntries(
    Object.entries(workflow.connections).filter(([name]) =>
      reachable.has(name),
    ),
  );
  workflow.id = 'SyntheticBillingTransportDev';
  workflow.name = 'DEV | Silmer | Cobranças transporte simulado';
  workflow.active = false;
  for (const [index, node] of workflow.nodes.entries()) {
    node.id = `billing-transport-dev-${index}`;
    if (node.name === TRIGGER) {
      node.webhookId = 'ff3bf77c-abef-4d32-9cae-ea73b2e16a37';
      node.parameters.path = 'silmer/order-billing-dev/send';
      node.parameters.authentication = 'basicAuth';
      node.credentials = {
        httpBasicAuth: { name: 'Silmer CRM para n8n Basic DEV' },
      };
    }
    if (node.type === 'n8n-nodes-base.httpRequest') {
      node.parameters.url = node.parameters.url.replace(
        '$env.SILMER_PANEL_BASE_URL',
        "'http://billing-crm:3000'",
      );
      node.parameters.authentication = 'genericCredentialType';
      node.parameters.genericAuthType = 'httpBasicAuth';
      node.credentials = {
        httpBasicAuth: { name: 'Silmer n8n para CRM Basic DEV' },
      };
      node.parameters.headerParameters.parameters =
        node.parameters.headerParameters.parameters
          .filter(
            (/** @type {any} */ header) => header.name !== 'Authorization',
          )
          .map((/** @type {any} */ header) => ({
            ...header,
            value:
              header.name === 'X-Silmer-Workflow-Key'
                ? 'whatsapp-mvp'
                : header.name === 'X-Silmer-Workflow-Version'
                  ? 'billing-transport-dev-1'
                  : header.value,
          }));
      node.parameters.options.redirect = {
        redirect: { followRedirects: false },
      };
    }
    if (node.name === SEND) {
      node.parameters.jsCode =
        "const command=$('Preparar reserva de envio humano (MVP)').item.json.command; const result=await this.helpers.httpRequest({method:'POST',url:'http://billing-crm:3000/__billing-development/transport/send',body:{command_id:command.command_id,message:command.message,to:command.to},json:true}); return {json:result};";
      node.onError = 'continueErrorOutput';
      node.retryOnFail = false;
    }
  }
  const sent = workflow.nodes.find(
    (/** @type {any} */ node) => node.name === SENT,
  );
  if (!sent) throw new Error('BILLING_DEV_TRANSPORT_CONTEXT_INVALID');
  const deliveredCode = {
    id: 'billing-transport-delivered-code',
    name: 'DEV - Preparar entrega simulada',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [sent.position[0] + 220, sent.position[1]],
    parameters: {
      mode: 'runOnceForEachItem',
      jsCode:
        "const sent=$('Preparar message.sent humano (MVP)').item.json;const id='delivered:'+sent.command_id;return {json:{...sent,idempotency_key:id,payload:{...sent.payload,event_id:id,event_type:'message.delivered',occurred_at:new Date().toISOString()}}};",
    },
  };
  const delivered = {
    ...structuredClone(sent),
    id: 'billing-transport-delivered-http',
    name: 'DEV - Registrar entrega simulada',
    position: [sent.position[0] + 440, sent.position[1]],
  };
  workflow.nodes.push(deliveredCode, delivered);
  workflow.connections[SENT] = { main: [[edge(deliveredCode.name)]] };
  workflow.connections[deliveredCode.name] = { main: [[edge(delivered.name)]] };
  workflow.connections[delivered.name] = { main: [[edge(ACK)]] };
  return workflow;
}
