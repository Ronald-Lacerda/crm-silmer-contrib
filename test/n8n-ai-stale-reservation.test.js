import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {
  patchAiStaleReservation,
  unwrapAiReservationResponse,
} from '../ops/n8n/patch-ai-stale-reservation.mjs';

const REQUEST = 'CRM - Reservar envio da IA (MVP)';
const VALIDATE = 'CRM - Validar reserva da IA (MVP)';
const baseline = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const node = (/** @type {any} */ workflow, /** @type {string} */ name) =>
  workflow.nodes.find((/** @type {any} */ item) => item.name === name);
function sourceWorkflow() {
  const workflow = structuredClone(baseline);
  node(workflow, REQUEST).credentials = {
    httpBasicAuth: { id: 'synthetic-crm', name: 'Synthetic credential' },
  };
  workflow.activeVersionId = 'synthetic-published-version';
  workflow.versionId = workflow.activeVersionId;
  workflow.active = true;
  return workflow;
}
const stale = () => ({
  statusCode: 409,
  headers: { 'content-type': 'application/problem+json' },
  body: {
    accepted: false,
    detail: 'Conflict',
    error: { code: 'STALE_AUTOMATION_FENCE' },
    instance: '/api/v1/integrations/n8n/events',
    request_id: 'synthetic-request',
    status: 409,
    title: 'Conflict',
    type: 'urn:silmer:problem:stale_automation_fence',
  },
});

test('OPS-INBOX-SEND-08: only the closed 409 stale fence cancels the obsolete turn', () => {
  assert.equal(unwrapAiReservationResponse(stale()), null);
  for (const response of [
    { ...stale(), statusCode: 500 },
    { ...stale(), body: { ...stale().body, status: 500 } },
    { ...stale(), body: { ...stale().body, accepted: true } },
    {
      ...stale(),
      body: { ...stale().body, error: { code: 'SUBJECT_TARGET_REQUIRED' } },
    },
    { ...stale(), body: { ...stale().body, type: 'unrelated' } },
    { statusCode: 409, body: { code: 'STALE_AUTOMATION_FENCE' } },
  ])
    assert.throws(
      () => unwrapAiReservationResponse(response),
      /AI_RESERVATION_HTTP_/u,
    );
});

test('OPS-INBOX-SEND-08: successful and duplicate reservations keep their complete original body', () => {
  for (const statusCode of [200, 202])
    for (const send_authorized of [true, false]) {
      const body = {
        accepted: true,
        duplicate: !send_authorized,
        send_authorized,
        event_id: 'synthetic-reservation',
        projection: { applied: false, error: 'STALE_PROJECTION' },
        order: { opened: false, error: 'ORDER_OPEN_FAILED' },
      };
      assert.equal(unwrapAiReservationResponse({ statusCode, body }), body);
    }
  for (const response of [
    { statusCode: 200, body: { accepted: true } },
    { statusCode: 200, body: { accepted: false, send_authorized: true } },
    { statusCode: 202, body: { accepted: true, send_authorized: 'true' } },
    { statusCode: 204, body: {} },
    { statusCode: 200, body: [] },
    {},
  ])
    assert.throws(
      () => unwrapAiReservationResponse(response),
      /AI_RESERVATION_RESPONSE_INVALID/u,
    );
});

test('OPS-INBOX-SEND-08: authentication, server and other conflict failures remain technical errors', () => {
  for (const statusCode of [401, 403, 404, 408, 409, 425, 429, 500, 502, 503]) {
    const body = {
      private: 'private-error-canary',
      error: { code: 'OTHER_FAILURE' },
    };
    assert.throws(
      () => unwrapAiReservationResponse({ statusCode, body }),
      (error) => {
        assert.equal(
          /** @type {Error} */ (error).message,
          `AI_RESERVATION_HTTP_${statusCode}`,
        );
        assert.doesNotMatch(
          String(error),
          /private-error-canary|OTHER_FAILURE/u,
        );
        return true;
      },
    );
  }
});

test('OPS-INBOX-SEND-08: the patch preserves both downstream branches, private configuration and source', () => {
  const source = sourceWorkflow();
  const before = structuredClone(source);
  const outgoing = structuredClone(source.connections[REQUEST]);
  const { workflow, changedNodeNames } = patchAiStaleReservation(source);
  assert.deepEqual(source, before);
  assert.deepEqual(changedNodeNames, [REQUEST, VALIDATE]);
  assert.equal(workflow.nodes.length, source.nodes.length + 1);
  assert.deepEqual(workflow.settings, source.settings);
  assert.equal(workflow.versionId, source.versionId);
  assert.equal(workflow.activeVersionId, source.activeVersionId);
  assert.equal(workflow.active, source.active);
  const expectedRequest = structuredClone(node(source, REQUEST));
  expectedRequest.retryOnFail = false;
  delete expectedRequest.maxTries;
  delete expectedRequest.waitBetweenTries;
  Object.assign(expectedRequest.parameters.options.response.response, {
    fullResponse: true,
    neverError: true,
  });
  assert.deepEqual(node(workflow, REQUEST), expectedRequest);
  for (const original of source.nodes)
    if (original.name !== REQUEST)
      assert.deepEqual(node(workflow, original.name), original);
  for (const [name, connections] of Object.entries(source.connections))
    if (name !== REQUEST)
      assert.deepEqual(workflow.connections[name], connections);
  assert.deepEqual(workflow.connections[REQUEST], {
    main: [[{ node: VALIDATE, type: 'main', index: 0 }]],
  });
  assert.deepEqual(workflow.connections[VALIDATE], outgoing);
  assert.deepEqual(
    outgoing.main[0].map((/** @type {any} */ item) => item.node).sort(),
    ['Envio da IA autorizado? (MVP)', 'Pedido não abriu? (MVP)'].sort(),
  );
  assert.equal(node(workflow, REQUEST).onError, undefined);
  assert.equal(node(workflow, VALIDATE).onError, undefined);
  assert.deepEqual(patchAiStaleReservation(workflow), {
    workflow,
    changedNodeNames: [],
  });
});

test('OPS-INBOX-SEND-08: stale emits no downstream item, success preserves pairing, and code never calls a service', () => {
  const { workflow } = patchAiStaleReservation(sourceWorkflow());
  let externalCalls = 0;
  const rejectExternalCall = () => {
    externalCalls++;
    throw new Error('Unexpected external effect');
  };
  const run = (/** @type {any[]} */ responses) =>
    vm.runInNewContext(
      '(function(){' + node(workflow, VALIDATE).parameters.jsCode + '})()',
      {
        $input: { all: () => responses.map((json) => ({ json })) },
        fetch: rejectExternalCall,
        $http: rejectExternalCall,
      },
    );
  assert.equal(JSON.stringify(run([stale()])), '[]');
  const body = { accepted: true, send_authorized: true, duplicate: false };
  assert.equal(
    JSON.stringify(run([stale(), { statusCode: 202, body }])),
    JSON.stringify([{ json: body, pairedItem: { item: 1 } }]),
  );
  for (const statusCode of [401, 409, 500])
    assert.throws(
      () => run([{ statusCode, body: {} }]),
      new RegExp(`AI_RESERVATION_HTTP_${statusCode}`, 'u'),
    );
  assert.equal(externalCalls, 0);
});

test('OPS-INBOX-SEND-08: unknown node shapes, named references and partial patches fail closed', () => {
  for (const mutate of [
    (/** @type {any} */ workflow) =>
      workflow.nodes.push(structuredClone(node(workflow, REQUEST))),
    (/** @type {any} */ workflow) => {
      node(workflow, REQUEST).parameters.method = 'GET';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, REQUEST).parameters.url = 'https://unrelated.invalid';
    },
    (/** @type {any} */ workflow) => {
      node(workflow, REQUEST).onError = 'continueRegularOutput';
    },
    (/** @type {any} */ workflow) => {
      delete node(workflow, REQUEST).credentials;
    },
    (/** @type {any} */ workflow) => {
      workflow.connections[REQUEST].main.push([]);
    },
    (/** @type {any} */ workflow) => {
      node(
        workflow,
        'Envio da IA autorizado? (MVP)',
      ).parameters.privateExpression =
        `={{ $('${REQUEST}').item.json.send_authorized }}`;
    },
  ]) {
    const source = sourceWorkflow();
    mutate(source);
    assert.throws(() => patchAiStaleReservation(source), /AI_RESERVATION_/u);
  }
  for (const mutate of [
    (/** @type {any} */ workflow) => {
      node(workflow, REQUEST).retryOnFail = true;
    },
    (/** @type {any} */ workflow) => {
      node(workflow, VALIDATE).parameters.jsCode += '\nreturn [];';
    },
    (/** @type {any} */ workflow) => {
      workflow.connections[VALIDATE].main[0] = [
        { node: VALIDATE, type: 'main', index: 0 },
      ];
    },
  ]) {
    const { workflow } = patchAiStaleReservation(sourceWorkflow());
    mutate(workflow);
    assert.throws(
      () => patchAiStaleReservation(workflow),
      /AI_RESERVATION_PATCH_CONTEXT_MISMATCH/u,
    );
  }
});

test('OPS-INBOX-SEND-08: diagnostic name labels survive while actual n8n lookups fail closed', () => {
  const source = sourceWorkflow();
  node(source, 'Envio da IA autorizado? (MVP)').parameters.diagnostics =
    `const map = new Map([[${JSON.stringify(REQUEST)}, 'WORKFLOW_NODE_SYNTHETIC']]);`;
  assert.doesNotThrow(() => patchAiStaleReservation(source));
  for (const expression of [
    `={{ $('${REQUEST}').item.json.send_authorized }}`,
    `={{ $( "${REQUEST}" ).first().json.send_authorized }}`,
    `={{ $node['${REQUEST}'].json.send_authorized }}`,
    `={{ $node [ "${REQUEST}" ].json.send_authorized }}`,
  ]) {
    const changed = sourceWorkflow();
    node(changed, 'Envio da IA autorizado? (MVP)').parameters.lookup =
      expression;
    assert.throws(
      () => patchAiStaleReservation(changed),
      /AI_RESERVATION_NAMED_REFERENCE_UNSUPPORTED/u,
    );
  }
});
