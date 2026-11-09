import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createBillingDevelopmentTransportWorkflow } from '../ops/n8n/workflows/create-order-billing-transport-dev-workflow.mjs';

test('BDEV201: DEV transport derives the canonical reservation and billing preflight without mutating production', async () => {
  const original = JSON.parse(
    await readFile(
      'ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      'utf8',
    ),
  );
  const baseline = JSON.stringify(original);
  const workflow = createBillingDevelopmentTransportWorkflow(original);
  assert.equal(JSON.stringify(original), baseline);
  assert.equal(workflow.active, false);
  assert.equal(workflow.id, 'SyntheticBillingTransportDev');
  assert.equal(
    workflow.nodes.some((/** @type {any} */ node) =>
      node.type.includes('langchain'),
    ),
    false,
  );
  const trigger = workflow.nodes.find(
    (/** @type {any} */ node) => node.type === 'n8n-nodes-base.webhook',
  );
  assert.equal(trigger.parameters.path, 'silmer/order-billing-dev/send');
  assert.equal(trigger.parameters.authentication, 'basicAuth');
  assert.equal(
    workflow.connections['Mensagem humana tem midia? (MVP)'].main[1][0].node,
    'Texto humano e cobranca? (MVP)',
  );
  assert.equal(
    workflow.connections['Validar preflight de cobranca (MVP)'].main[0][0].node,
    'DEV - Simular envio humano (MVP)',
  );
  for (const node of workflow.nodes.filter(
    (/** @type {any} */ node) => node.type === 'n8n-nodes-base.httpRequest',
  )) {
    assert.ok(node.parameters.url.includes('http://billing-crm:3000'));
    assert.equal(
      node.credentials.httpBasicAuth.name,
      'Silmer n8n para CRM Basic DEV',
    );
    assert.equal(
      node.parameters.options.redirect.redirect.followRedirects,
      false,
    );
  }
  const send = workflow.nodes.find(
    (/** @type {any} */ node) =>
      node.name === 'DEV - Simular envio humano (MVP)',
  );
  assert.ok(
    send.parameters.jsCode.includes(
      'http://billing-crm:3000/__billing-development/transport/send',
    ),
  );
  assert.equal(send.retryOnFail, false);
  assert.equal(send.onError, 'continueErrorOutput');
  assert.equal(
    workflow.connections['CRM - Registrar message.sent humano (MVP)'].main[0][0]
      .node,
    'DEV - Preparar entrega simulada',
  );
  assert.equal(
    workflow.connections['DEV - Registrar entrega simulada'].main[0][0].node,
    'Responder comando aceito (MVP)',
  );
});
