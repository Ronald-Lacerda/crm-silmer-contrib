import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  billingSendPreflightValid,
  patchBillingSendPreflight,
} from '../ops/n8n/billing-send-preflight.mjs';
import { createEvolutionWorkflow } from '../ops/n8n/workflows/create-evolution-workflow.mjs';

const MEDIA = 'Mensagem humana tem midia? (MVP)';
const SEND = 'WhatsApp - Enviar texto humano (MVP)';
const REQUIRED = 'Texto humano e cobranca? (MVP)';
const CHECK = 'CRM - Preflight cobranca reservada (MVP)';
const VALIDATE = 'Validar preflight de cobranca (MVP)';
const FAILURE = 'Falha de preflight da midia (MVP)';
const RESERVE = 'Preparar reserva de envio humano (MVP)';
const added = [REQUIRED, CHECK, VALIDATE];
const baseline = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const generated = patchBillingSendPreflight(
  createEvolutionWorkflow(baseline, {
    ownNumber: '5511000000000',
    apiCredentialId: 'synthetic-api',
  }),
).workflow;
const node = (/** @type {any} */ w, /** @type {string} */ name) =>
  w.nodes.find((/** @type {any} */ n) => n.name === name);
const edge = (/** @type {string} */ name) => ({
  node: name,
  type: 'main',
  index: 0,
});
function source() {
  const w = structuredClone(generated);
  w.nodes = w.nodes.filter((/** @type {any} */ n) => !added.includes(n.name));
  for (const name of added) delete w.connections[name];
  w.connections[MEDIA].main[1] = [edge(SEND)];
  return w;
}

test('BAPI-07/09/10: offline patch adds a narrow final billing guard without changing credentials or other branches', () => {
  const before = source();
  const snapshot = structuredClone(before);
  const { workflow, changedNodeNames } = patchBillingSendPreflight(before);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(changedNodeNames, [MEDIA, ...added]);
  for (const original of before.nodes)
    assert.deepEqual(node(workflow, original.name), original);
  for (const [name, connections] of Object.entries(before.connections))
    if (name !== MEDIA)
      assert.deepEqual(workflow.connections[name], connections);
  assert.deepEqual(
    workflow.connections[MEDIA].main[0],
    before.connections[MEDIA].main[0],
  );
  const template = node(before, 'CRM - Preflight midia reservada (MVP)');
  const request = node(workflow, CHECK);
  assert.deepEqual(request.credentials, template.credentials);
  assert.deepEqual(
    request.parameters.headerParameters,
    template.parameters.headerParameters,
  );
  assert.equal(request.parameters.method, 'GET');
  assert.equal(
    request.parameters.url,
    template.parameters.url.replace('/media?preflight=true', '/preflight'),
  );
  assert.equal(request.retryOnFail, false);
  assert.equal(
    request.parameters.options.redirect.redirect.followRedirects,
    false,
  );
  assert.deepEqual(workflow, generated);
  assert.deepEqual(patchBillingSendPreflight(workflow).changedNodeNames, []);
});

test('BAPI-09: strict authorization rejects malformed and negative CRM responses', () => {
  assert.equal(billingSendPreflightValid({ valid: true }), true);
  for (const value of [
    null,
    undefined,
    {},
    { valid: false },
    { valid: 'true' },
    { valid: 1 },
    { error: 'unavailable' },
  ])
    assert.equal(billingSendPreflightValid(value), false);
});

test('BAPI-10: a private workflow keeps its CRM Basic credential identity', () => {
  const before = source();
  const credentials = {
    httpBasicAuth: {
      id: 'synthetic-private-basic-id',
      name: 'synthetic private credential',
    },
  };
  node(before, 'CRM - Preflight midia reservada (MVP)').credentials =
    credentials;
  const { workflow } = patchBillingSendPreflight(before);
  assert.deepEqual(node(workflow, CHECK).credentials, credentials);
  assert.notEqual(node(workflow, CHECK).credentials, credentials);
});

test('BAPI-07/09/10: synthetic HTTP success, refusal and failure cannot bypass the pre-transport branch', async () => {
  const w = generated;
  /** @type {any} */
  const command = {
    billing_send: true,
    command_id: 'synthetic-command',
    conversation_id: 'synthetic-conversation',
    automation_epoch: 4,
    source_revision: 2,
    message: { type: 'text', text: 'synthetic billing link' },
  };
  const reserved = { command, correlation_id: 'synthetic-correlation' };
  const lookup = (/** @type {string} */ name) => {
    assert.equal(name, RESERVE);
    return { item: { json: reserved } };
  };
  const required = node(w, REQUIRED).parameters.conditions.conditions[0]
    .leftValue;
  const expression = required.slice(3, -2).trim();
  for (const marker of [undefined, false, 'true', true]) {
    command.billing_send = marker;
    assert.equal(
      vm.runInNewContext(expression, { $: lookup }),
      marker === true,
    );
  }
  command.billing_send = true;
  for (const scenario of ['allow', 'deny', 'malformed', 'http-error']) {
    let sends = 0;
    let reads = 0;
    const http = async (/** @type {any} */ request) => {
      reads += 1;
      assert.equal(request.parameters.method, 'GET');
      assert.equal(request.parameters.genericAuthType, 'httpBasicAuth');
      if (scenario === 'http-error') throw new Error('synthetic timeout');
      return scenario === 'allow'
        ? { valid: true }
        : scenario === 'deny'
          ? { valid: false }
          : { valid: 'true' };
    };
    let next;
    try {
      const response = await http(node(w, CHECK));
      next = w.connections[CHECK].main[0][0].node;
      assert.equal(next, VALIDATE);
      vm.runInNewContext(
        `(function(){${node(w, VALIDATE).parameters.jsCode}})()`,
        { $json: response },
      );
      next = w.connections[VALIDATE].main[0][0].node;
    } catch {
      next = w.connections[CHECK].main[1][0].node;
      assert.equal(w.connections[VALIDATE].main[1][0].node, next);
    }
    if (next === SEND) sends += 1;
    else {
      assert.equal(next, FAILURE);
      const failure = vm.runInNewContext(
        `(function(){${node(w, FAILURE).parameters.jsCode}})()`,
        { $: lookup, $execution: { id: 'synthetic-execution' } },
      );
      assert.equal(failure.json.payload.failure.phase, 'before_message_send');
      assert.equal(
        failure.json.payload.failure.code,
        'MEDIA_PREFLIGHT_REJECTED',
      );
      assert.equal(failure.json.payload.command_id, command.command_id);
      assert.equal(
        w.connections[FAILURE].main[0][0].node,
        'CRM - Concluir falha anterior ao envio (MVP)',
      );
    }
    assert.equal(reads, 1);
    assert.equal(sends, scenario === 'allow' ? 1 : 0);
  }
});

test('BAPI-10: patch refuses drift, ambiguous nodes, partial patches and colliding IDs', () => {
  for (const mutate of [
    (/** @type {any} */ w) => w.nodes.push(structuredClone(node(w, SEND))),
    (/** @type {any} */ w) => {
      w.connections[MEDIA].main[1] = [];
    },
    (/** @type {any} */ w) => {
      node(w, 'CRM - Preflight midia reservada (MVP)').parameters.url =
        'https://synthetic.invalid';
    },
    (/** @type {any} */ w) =>
      w.nodes.push({ id: 'billing-send-preflight-check', name: 'collision' }),
    (/** @type {any} */ w) =>
      w.nodes.push(structuredClone(node(generated, CHECK))),
  ]) {
    const w = source();
    mutate(w);
    assert.throws(() => patchBillingSendPreflight(w), /BILLING_PREFLIGHT_/);
  }
  const drift = structuredClone(generated);
  node(drift, CHECK).retryOnFail = true;
  assert.throws(
    () => patchBillingSendPreflight(drift),
    /BILLING_PREFLIGHT_PATCH_CONTEXT_MISMATCH/,
  );
});
