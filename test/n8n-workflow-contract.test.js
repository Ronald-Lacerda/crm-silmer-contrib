import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { BRIEFING_PATCH_FIELDS } from '../modules/n8n-integration/src/service.js';
import {
  ContractValidationError,
  validateBriefingPatch,
  validateEvent,
} from '../schemas/fixtures/external/n8n/contract-validator.mjs';

const fixtureRoot = new URL(
  '../schemas/fixtures/external/n8n/',
  import.meta.url,
);
const workflowSnapshot = new URL(
  '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
  import.meta.url,
);

/** @param {string} name @returns {Promise<any>} */
async function fixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8'));
}

/** @returns {Promise<Map<string, any>>} */
async function workflowNodesByName() {
  const workflow = JSON.parse(await readFile(workflowSnapshot, 'utf8'));
  return new Map(
    workflow.nodes.map((/** @type {any} */ node) => [node.name, node]),
  );
}

/**
 * Runs an n8n "run once for each item" Code node body outside n8n, with only
 * the `$json` item and the `$('<node>')` lookups the body actually uses.
 *
 * @param {string} jsCode
 * @param {any} item
 * @param {Record<string, any>} upstream
 * @returns {any}
 */
function runCodeNode(jsCode, item, upstream) {
  const result = vm.runInNewContext(`(() => {\n${jsCode}\n})()`, {
    $json: item,
    $: (/** @type {string} */ name) => ({ item: { json: upstream[name] } }),
    $execution: { id: '42' },
  });
  return JSON.parse(JSON.stringify(result.json));
}

class ConversationFenceHarness {
  constructor() {
    this.automationEpoch = 3;
    this.claimedRevision = 6;
    this.mode = 'assistant';
    this.revision = 7;
    this.reservations = new Map();
  }

  takeover() {
    this.automationEpoch += 1;
    this.mode = 'human';
  }

  /** @param {any} event @param {any} contract */
  reserve(event, contract) {
    validateEvent(event, contract);
    const fingerprint = JSON.stringify(event);
    const existing = this.reservations.get(event.command_id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ContractValidationError('IDEMPOTENCY_KEY_REUSED');
      }
      return { send_authorized: false };
    }
    if (
      this.mode !== 'assistant' ||
      event.automation_epoch !== this.automationEpoch ||
      event.source_revision !== this.revision ||
      this.claimedRevision >= event.source_revision
    ) {
      throw new ContractValidationError('STALE_AUTOMATION_FENCE');
    }
    this.claimedRevision = event.source_revision;
    this.reservations.set(event.command_id, { fingerprint });
    return { send_authorized: true };
  }
}

/** @param {string|null} current @param {string} incoming @param {string[]} order */
function applyDeliveryStatus(current, incoming, order) {
  if (incoming === 'failed') return current;
  const currentRank = current === null ? -1 : order.indexOf(current);
  const incomingRank = order.indexOf(incoming);
  if (incomingRank < 0) throw new ContractValidationError('INVALID_STATUS');
  return incomingRank > currentRank ? incoming : current;
}

/** @param {Record<string, unknown>} current @param {any} patch @param {any} contract */
function applyBriefingPatch(current, patch, contract) {
  validateBriefingPatch(patch, contract);
  return Object.fromEntries([
    ...Object.entries(current),
    ...Object.entries(patch).filter(([, value]) => value !== null),
  ]);
}

test('folds claim into one reservation per current inbound revision', async () => {
  const contract = await fixture('contract-v1.json');
  const event = await fixture('message-send-requested.json');
  const fence = new ConversationFenceHarness();

  assert.equal(fence.reserve(event, contract).send_authorized, true);
  assert.equal(fence.reserve(event, contract).send_authorized, false);
  assert.throws(
    () =>
      fence.reserve(
        { ...event, command_id: 'command-second', event_id: 'event-second' },
        contract,
      ),
    /STALE_AUTOMATION_FENCE/u,
  );
});

test('takeover and a newer inbound revision invalidate an old AI decision', async () => {
  const contract = await fixture('contract-v1.json');
  const event = await fixture('message-send-requested.json');

  const takeoverFence = new ConversationFenceHarness();
  takeoverFence.takeover();
  assert.throws(
    () => takeoverFence.reserve(event, contract),
    /STALE_AUTOMATION_FENCE/u,
  );

  const revisionFence = new ConversationFenceHarness();
  revisionFence.revision += 1;
  assert.throws(
    () => revisionFence.reserve(event, contract),
    /STALE_AUTOMATION_FENCE/u,
  );
});

test('merges only approved, non-null briefing fields', async () => {
  const contract = await fixture('contract-v1.json');
  assert.deepEqual(
    applyBriefingPatch(
      { quantity: 10, segment: 'uniform' },
      { quantity: 30, segment: null },
      contract,
    ),
    { quantity: 30, segment: 'uniform' },
  );
  for (const forbidden of [{ payment_confirmed: true }, { price: 100 }]) {
    assert.throws(() => validateBriefingPatch(forbidden, contract));
  }
  assert.equal(
    validateBriefingPatch(
      {
        customer_name: 'Grupo Aurora',
        fabrics: ['dry fit'],
        next_required_field: 'sizes',
        order_name: 'Evento Aurora',
        product_type: 'camiseta',
      },
      contract,
    ),
    true,
  );
});

test('never regresses delivery status when callbacks arrive out of order', async () => {
  const contract = await fixture('contract-v1.json');
  let status = null;
  for (const incoming of ['sent', 'delivered', 'read', 'delivered', 'sent']) {
    status = applyDeliveryStatus(
      status,
      incoming,
      contract.deliveryStatusOrder,
    );
  }
  assert.equal(status, 'read');
});

test('keeps the simplified workflow inactive and free of removed runtime concepts', async () => {
  const workflow = JSON.parse(await readFile(workflowSnapshot, 'utf8'));
  assert.equal(workflow.source.active, false);
  assert.equal(workflow.source.activeVersionId, null);
  // Baseline includes the static site redirect; legacy nodes stay disconnected.
  // VND-L02 item 5: the burst window, the reread and the newest-message check.
  // VND-L03: the transcript back to the CRM (check, preparation and call) and
  // the handoff of a failed model or decision.
  assert.equal(workflow.nodes.length, 94);
  const serialized = JSON.stringify(workflow);
  assert.doesNotMatch(serialized, /claim_token|claim_id|ai-turns\/claim/u);
  assert.doesNotMatch(serialized, /silmer_failures|windowBufferMemory/u);
  assert.doesNotMatch(serialized, /"(?:credentials|webhookId|pinData)":/u);

  const reserveNodes = workflow.nodes.filter((/** @type {any} */ node) =>
    /Reservar envio/u.test(node.name),
  );
  const sendNodes = workflow.nodes.filter(
    (/** @type {any} */ node) =>
      node.type === 'n8n-nodes-base.whatsApp' &&
      node.parameters?.operation === 'send',
  );
  assert.ok(reserveNodes.length >= 1);
  assert.ok(sendNodes.length >= 1);
  assert.match(serialized, /pré-ficha do pedido/u);
  assert.match(serialized, /ready_for_handoff/u);
  assert.match(serialized, /next_required_field/u);
});

test('site text reaches CRM delivery and unsupported media is refused', async () => {
  const nodes = await workflowNodesByName();
  const normalize = nodes.get('Normalizar comando do painel (MVP)');
  for (const type of ['text', 'image', 'audio', 'video']) {
    for (const to of [
      '+999012345678901',
      '999012345678901',
      '+5541999990000',
    ]) {
      const command = {
        schema_version: '1.0',
        command_id: 'command-1',
        action: 'send_message',
        to,
        message: { type, text: 'Mensagem sintética' },
      };
      const normalized = runCodeNode(
        normalize.parameters.jsCode,
        {
          body: command,
          headers: { 'idempotency-key': 'command-1' },
        },
        {},
      );
      assert.equal(
        normalized.kind,
        to.includes('999012')
          ? type === 'text'
            ? 'site_chat'
            : 'site_chat_media'
          : 'send',
      );
    }
  }
  const workflow = JSON.parse(await readFile(workflowSnapshot, 'utf8'));
  assert.deepEqual(
    workflow.connections['Rotear comando do painel (MVP)'].main[2],
    [
      {
        node: 'Preparar reserva de envio humano (MVP)',
        type: 'main',
        index: 0,
      },
    ],
  );
  assert.deepEqual(
    workflow.connections['Rotear comando do painel (MVP)'].main[3],
    [{ node: 'Recusar mídia no chat do site (MVP)', type: 'main', index: 0 }],
  );
  assert.equal(
    nodes.get('Recusar mídia no chat do site (MVP)').parameters.options
      .responseCode,
    422,
  );
});

test('opens the order with the reply or the handoff, never on a call of its own (ADR 014)', async () => {
  const contract = await fixture('contract-v1.json');
  const workflow = JSON.parse(await readFile(workflowSnapshot, 'utf8'));
  const byName = new Map(
    workflow.nodes.map((/** @type {any} */ node) => [node.name, node]),
  );
  /** @param {string} source @param {number} [output] */
  const targets = (source, output = 0) =>
    (workflow.connections[source]?.main?.[output] ?? []).map(
      (/** @type {any} */ edge) => edge.node,
    );
  const serialized = JSON.stringify(workflow);

  // The parallel, fire-and-forget intent branch is gone.
  assert.doesNotMatch(serialized, /event_type: 'order\.intent_confirmed'/u);
  for (const retired of [
    'Cliente confirmou intenção de pedido? (MVP)',
    'Preparar intenção de pedido (MVP)',
    'CRM - Registrar intenção de pedido (MVP)',
  ]) {
    assert.equal(byName.has(retired), false, retired);
  }
  assert.deepEqual(targets('Normalizar decisão da IA (MVP)'), [
    'Transferir para humano? (MVP)',
  ]);

  // open_order rides on the reservation and on the handoff.
  const decision = {
    conversation_id: 'conversation-1',
    automation_epoch: 2,
    source_revision: 7,
    briefing_patch: { quantity: 30 },
    handoff_reason: 'negotiation',
    reasoning: 'Motivo: Perguntou o valor.',
    reply_text: 'Qual a cor da camisa?',
    open_order: true,
  };
  const reservation = runCodeNode(
    byName.get('Preparar reserva de envio da IA (MVP)').parameters.jsCode,
    decision,
    {},
  );
  const handoff = runCodeNode(
    byName.get('Preparar handoff da IA (MVP)').parameters.jsCode,
    decision,
    {},
  );
  for (const event of [reservation.payload, handoff.payload]) {
    assert.equal(event.open_order, true, event.event_type);
    assert.equal(validateEvent(event, contract), true);
  }
  assert.equal(
    runCodeNode(
      byName.get('Preparar reserva de envio da IA (MVP)').parameters.jsCode,
      { ...decision, open_order: false },
      {},
    ).payload.open_order,
    false,
  );

  // The CRM answers on the same call; both answers reach the failure check.
  assert.deepEqual(targets('CRM - Reservar envio da IA (MVP)').sort(), [
    'Envio da IA autorizado? (MVP)',
    'Pedido não abriu? (MVP)',
  ]);
  assert.deepEqual(targets('CRM - Registrar handoff (MVP)').sort(), [
    'Pedido não abriu? (MVP)',
    'Preparar aviso de transferência (MVP)',
  ]);
  assert.deepEqual(targets('Pedido não abriu? (MVP)'), [
    'Preparar falha ao abrir pedido (MVP)',
  ]);
  assert.deepEqual(targets('Pedido não abriu? (MVP)', 1), []);
  assert.deepEqual(targets('Preparar falha ao abrir pedido (MVP)'), [
    'CRM - Registrar falha ao abrir pedido (MVP)',
  ]);
  // n8n (executionOrder v1) runs sibling branches top to bottom: the check
  // sits above the reply and the notice, so they still end the execution.
  assert.equal(workflow.settings.executionOrder, 'v1');
  const check = byName.get('Pedido não abriu? (MVP)');
  for (const sibling of [
    'Envio da IA autorizado? (MVP)',
    'Preparar aviso de transferência (MVP)',
  ]) {
    assert.ok(check.position[1] < byName.get(sibling).position[1], sibling);
  }
  // Reporting the failure can never block what the customer receives.
  const report = byName.get('CRM - Registrar falha ao abrir pedido (MVP)');
  assert.equal(report.onError, 'continueErrorOutput');
  assert.match(report.parameters.url, /integrations\/n8n\/events/u);
});

test('a failed order opening raises workflow.failed ORDER_OPEN_FAILED (ADR 014)', async () => {
  const contract = await fixture('contract-v1.json');
  const byName = await workflowNodesByName();
  const condition = /^=\{\{ (.*) \}\}$/u.exec(
    byName.get('Pedido não abriu? (MVP)').parameters.conditions.conditions[0]
      .leftValue,
  )?.[1];
  assert.ok(condition, 'expected an n8n expression on the failure check');
  /** @param {any} answer */
  const failed = (answer) => vm.runInNewContext(condition, { $json: answer });
  // An expression error on this check would stop the reply: no globals.
  assert.doesNotMatch(condition, /\b[A-Z][A-Za-z]*\(/u);
  assert.equal(
    failed({ accepted: true, order: { opened: false, error: 'X_Y' } }),
    'true',
  );
  assert.equal(
    failed({
      accepted: true,
      order: { opened: true, id: 'order-1', created: true },
    }),
    'false',
  );
  assert.equal(failed({ accepted: true, send_authorized: true }), 'false');
  assert.equal(failed({ accepted: true, order: null }), 'false');

  const prepare = byName.get('Preparar falha ao abrir pedido (MVP)').parameters
    .jsCode;
  const answer = {
    accepted: true,
    send_authorized: true,
    order: { opened: false, error: 'ORDER_OPEN_FAILED' },
  };
  const fromReply = runCodeNode(prepare, answer, {
    'Preparar reserva de envio da IA (MVP)': {
      payload: {
        conversation_id: 'conversation-1',
        event_id: 'reserve:conversation-1:7:ai-response',
        event_type: 'message.send.requested',
      },
    },
  });
  assert.deepEqual(fromReply.payload.failure, {
    code: 'ORDER_OPEN_FAILED',
    event_type: 'message.send.requested',
    reason: 'ORDER_OPEN_FAILED',
  });
  assert.equal(fromReply.payload.event_type, 'workflow.failed');
  assert.equal(fromReply.payload.conversation_id, 'conversation-1');
  assert.equal(
    fromReply.idempotency_key,
    'order-open-failed:reserve:conversation-1:7:ai-response',
  );
  assert.equal(fromReply.payload.event_id, fromReply.idempotency_key);
  assert.equal(validateEvent(fromReply.payload, contract), true);

  const fromMedia = runCodeNode(
    prepare,
    {
      ...answer,
      order: { opened: false, error: 'ORDERS_RUNTIME_UNAVAILABLE' },
    },
    {
      'Preparar handoff de conteúdo (MVP)': {
        payload: {
          conversation_id: 'conversation-2',
          event_id: 'conversation-2:4:unsupported',
          event_type: 'handoff.requested',
        },
      },
    },
  );
  assert.equal(fromMedia.payload.conversation_id, 'conversation-2');
  assert.equal(fromMedia.payload.failure.event_type, 'handoff.requested');
  assert.equal(fromMedia.payload.failure.reason, 'ORDERS_RUNTIME_UNAVAILABLE');
  assert.equal(validateEvent(fromMedia.payload, contract), true);
});

test('agent output parser tolerates stray keys instead of failing the execution', async () => {
  const byName = await workflowNodesByName();
  const parser = byName.get('Validar saída do MVP');
  assert.ok(parser, 'expected the structured output parser node to exist');
  const schema = JSON.parse(parser.parameters.inputSchema);

  assert.notEqual(
    schema.additionalProperties,
    false,
    'top-level stray keys (e.g. briefing_status) must not reject the reply',
  );
  assert.notEqual(
    schema.properties.briefing_patch.additionalProperties,
    false,
    'stray briefing_patch keys (e.g. order_intent_confirmed) must not reject the reply',
  );
  assert.doesNotMatch(
    parser.parameters.inputSchema,
    /"additionalProperties":false/u,
  );
  // Only the reply and the patch are required: the model sometimes nests or
  // omits the signals, and the decision node defaults them (ADR 009).
  assert.deepEqual([...schema.required].sort(), [
    'briefing_patch',
    'reply_text',
  ]);

  // ADR 014: the model no longer reports the intent; a stray flag still parses.
  assert.equal('order_intent_confirmed' in schema.properties, false);
  assert.equal(
    'order_intent_confirmed' in schema.properties.briefing_patch.properties,
    false,
  );
  const agent = byName.get('Atendente virtual Silmer (MVP)');
  assert.doesNotMatch(
    agent.parameters.options.systemMessage,
    /order_intent_confirmed/u,
  );
  assert.doesNotMatch(
    byName.get('Montar contexto da IA (MVP)').parameters.jsCode,
    /Intenção de pedido|order_intent_confirmed/u,
  );
});

test('decision normalizer whitelists briefing_patch keys exactly as the CRM does', async () => {
  const byName = await workflowNodesByName();
  const jsCode = byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode;
  const declaration = /const briefingFields = new Set\(\[([\s\S]*?)\]\);/u.exec(
    jsCode,
  );
  assert.ok(
    declaration,
    'expected a briefingFields whitelist in the normalizer',
  );
  const workflowFields = [...declaration[1].matchAll(/'([a-z_]+)'/gu)].map(
    (match) => match[1],
  );
  // The CRM ships a new field first (ADR 012); once the workflow sends it,
  // both lists match again (ADR 025: `audiences` since mvp-simple-13).
  assert.deepEqual(
    [...workflowFields].sort(),
    [...BRIEFING_PATCH_FIELDS].sort(),
  );
});

test('the CRM, the contract fixture and its schema list the same briefing fields', async () => {
  const contract = await fixture('contract-v1.json');
  const schema = await fixture('contract-v1.schema.json');
  const crmFields = [...BRIEFING_PATCH_FIELDS].sort();
  assert.deepEqual([...contract.briefingPatchFields].sort(), crmFields);
  assert.deepEqual(
    Object.keys(schema.$defs.briefingPatch.properties).sort(),
    crmFields,
  );
  // ADR 012: the collar is its own field.
  assert.ok(BRIEFING_PATCH_FIELDS.has('collar'));
  assert.deepEqual(schema.$defs.briefingPatch.properties.collar, {
    type: ['string', 'null'],
  });
  assert.equal(validateBriefingPatch({ collar: 'gola V' }, contract), true);
  assert.throws(
    () => validateBriefingPatch({ gola: 'gola V' }, contract),
    ContractValidationError,
  );
});

test('decision normalizer ignores the retired order intent flag and strips stray patch keys (ADR 014)', async () => {
  const byName = await workflowNodesByName();
  const jsCode = byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode;
  const context = {
    conversation_id: 'conversation-1',
    automation_epoch: 1,
    source_revision: 4,
    briefing: {},
  };
  // Verbatim shape returned by the model in DEV execution 54.
  const liveOutput = {
    output: {
      reply_text: 'Perfeito, Carla!',
      briefing_patch: {
        customer_name: 'Carla',
        product_model: 'camiseta básica',
        sizes: '20 M e 30 G',
        order_intent_confirmed: true,
        next_required_field: 'artwork_status',
      },
      handoff_ready: false,
      handoff_required: false,
      order_intent_confirmed: true,
      handoff_reason: null,
      reasoning: 'Cliente confirmou o orçamento.',
      briefing_status: 'collecting',
    },
  };

  const decision = runCodeNode(jsCode, liveOutput, {
    'Montar contexto da IA (MVP)': context,
  });
  // The type of shirt is a ficha point: that, not the flag, opens the order.
  assert.equal(decision.open_order, true);
  assert.equal('order_intent_confirmed' in decision, false);
  assert.equal('order_intent_confirmed' in decision.briefing_patch, false);
  assert.equal(decision.briefing_patch.customer_name, 'Carla');
  for (const key of Object.keys(decision.briefing_patch)) {
    assert.ok(BRIEFING_PATCH_FIELDS.has(key), `CRM would reject ${key}`);
  }

  // The flag alone, at the top level or inside the patch, opens nothing.
  const flagOnly = /** @type {any} */ (structuredClone(liveOutput));
  flagOnly.output.briefing_patch = {
    customer_name: 'Carla',
    order_intent_confirmed: true,
  };
  const ignored = runCodeNode(jsCode, flagOnly, {
    'Montar contexto da IA (MVP)': context,
  });
  assert.equal(ignored.open_order, false);
  assert.equal('order_intent_confirmed' in ignored.briefing_patch, false);
  assert.equal(ignored.briefing_patch.briefing_status, 'collecting');
});

test('decision normalizer applies the handoff rules of ADR 009', async () => {
  const byName = await workflowNodesByName();
  const jsCode = byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode;
  /** @param {any} output @param {any} [context] */
  const decide = (output, context = {}) =>
    runCodeNode(
      jsCode,
      {
        output: {
          reply_text: 'Resposta da IA',
          briefing_patch: {},
          answer_status: 'none',
          person_request: 'none',
          ...output,
        },
      },
      {
        'Montar contexto da IA (MVP)': {
          conversation_id: 'conversation-1',
          automation_epoch: 1,
          source_revision: 3,
          briefing: {},
          recent_messages: [],
          current_text: '',
          profile_name: 'Perfil do WhatsApp',
          sellers: ['Marina', 'Edson', 'Lúcio', 'Dario'],
          message_cap: 15,
          turn: 3,
          name_asks: 2,
          ...context,
        },
      },
    );

  // VND-L02 item 1 (supersedes ADR 009 item 4): the first price question is deferred with the
  // next point, and only a second one hands off as negotiation.
  const firstPrice = decide({}, { current_text: 'e quanto fica isso tudo?' });
  assert.equal(firstPrice.handoff_required, false);
  assert.match(firstPrice.reply_text, /^Quem passa o valor é o vendedor/u);
  assert.match(firstPrice.briefing_patch.briefing_status, /price_/u);
  const askedBefore = { briefing: { briefing_status: 'price_collecting' } };
  const price = decide(
    {},
    { ...askedBefore, current_text: 'e quanto fica isso tudo?' },
  );
  assert.equal(price.handoff_reason, 'negotiation');
  assert.match(price.reply_text, /vendedores/u);
  assert.equal(
    decide({}, { ...askedBefore, current_text: 'aceitam pix? parcelam?' })
      .trigger,
    'price',
  );
  assert.equal(
    decide(
      { asks_price: true },
      { current_text: 'vocês fazem orçamento de camiseta?' },
    ).handoff_required,
    false,
    'asking for a quote is not asking the price',
  );
  assert.equal(
    decide({}, { current_text: 'em quanto tempo fica pronto?' }).trigger,
    null,
  );

  const seller = decide(
    { person_request: 'named', requested_person_name: 'Mari' },
    { current_text: 'a Mari tá por aí?' },
  );
  assert.equal(seller.handoff_reason, 'human_requested');
  assert.equal(seller.requested_seller, 'Marina');
  assert.match(seller.reasoning, /Vendedor pedido: Marina/u);
  assert.equal(
    decide(
      { person_request: 'named', requested_person_name: 'Lucio' },
      { current_text: 'quero falar com o Lucio' },
    ).requested_seller,
    'Lúcio',
  );
  assert.equal(
    decide(
      { person_request: 'named', requested_person_name: 'Marina' },
      { current_text: 'são 30 peças' },
    ).trigger,
    null,
    'a name echoed from the history is not a new request',
  );

  const firstAsk = decide(
    { person_request: 'named', requested_person_name: 'João' },
    { current_text: 'quero falar com o João' },
  );
  assert.equal(firstAsk.handoff_required, false);
  assert.match(firstAsk.briefing_patch.notes, /João/u);
  const secondAsk = decide(
    { person_request: 'named', requested_person_name: 'João' },
    {
      current_text: 'cadê o João?',
      recent_messages: [
        { sender_type: 'customer', text: 'quero falar com o João' },
        { sender_type: 'ai', text: 'Vou avisar a equipe.' },
        { sender_type: 'customer', text: 'cadê o João?' },
      ],
    },
  );
  assert.equal(secondAsk.trigger, 'unknown_person_repeated');
  assert.equal(secondAsk.handoff_reason, 'human_requested');

  const firstMiss = decide(
    { answer_status: 'unclear' },
    { briefing: { product_type: 'camisetas', next_required_field: 'colors' } },
  );
  assert.equal(firstMiss.handoff_required, false);
  assert.equal(firstMiss.briefing_patch.briefing_status, 'quote_clarifying');
  const question = decide(
    { answer_status: 'question' },
    {
      briefing: {
        product_type: 'camisetas',
        next_required_field: 'colors',
        briefing_status: 'quote_clarifying',
      },
    },
  );
  assert.equal(question.handoff_required, false);
  assert.equal(question.briefing_patch.briefing_status, 'quote_clarifying');
  const secondMiss = decide(
    { answer_status: 'undecided' },
    {
      briefing: {
        product_type: 'camisetas',
        next_required_field: 'colors',
        briefing_status: 'quote_clarifying',
      },
    },
  );
  assert.equal(secondMiss.trigger, 'two_attempts');
  assert.equal(secondMiss.handoff_reason, 'low_confidence');

  const cap = decide({}, { turn: 15 });
  assert.equal(cap.trigger, 'message_limit');
  assert.match(cap.reasoning, /Limite de 15 mensagens/u);
  assert.equal(decide({}, { turn: 14 }).handoff_required, false);
  // VND-L02 item 1: a first price question at the cap is the cap, and the summary says it.
  const capPrice = decide(
    { asks_price: true },
    { turn: 15, current_text: 'qual o valor?' },
  );
  assert.equal(capPrice.trigger, 'message_limit');
  assert.match(capPrice.reasoning, /Perguntou o valor\./u);
  assert.equal(
    decide(
      { asks_price: true },
      { ...askedBefore, turn: 15, current_text: 'qual o valor?' },
    ).trigger,
    'price',
  );

  const sticky = decide(
    { order_intent_confirmed: false },
    { briefing: { briefing_status: 'quote_collecting' } },
  );
  assert.equal(sticky.open_order, true, 'an order once opened stays open');
  assert.equal(sticky.briefing_patch.briefing_status, 'quote_collecting');

  const profile = decide(
    { briefing_patch: { customer_name: 'Perfil do WhatsApp' } },
    { current_text: 'oi' },
  );
  assert.equal('customer_name' in profile.briefing_patch, false);

  const flattened = decide({
    briefing_patch: {
      product_type: ['camiseta', 'boné'],
      quantity: { camiseta: 30, bone: 30 },
      artwork_status: 'não informado',
    },
  });
  assert.equal(flattened.briefing_patch.product_type, 'camiseta, boné');
  assert.equal(flattened.briefing_patch.quantity, 'camiseta: 30; bone: 30');
  assert.equal('artwork_status' in flattened.briefing_patch, false);
  assert.equal(
    'sizes' in
      decide({ briefing_patch: { sizes: 'a definir com o time' } })
        .briefing_patch,
    false,
  );

  // The name and the ficha points of a shirt (ADR 012, ADR 024; VND-L02 adds
  // the fabric and the artwork).
  const complete = {
    customer_name: 'Ana',
    product_type: 'camisetas',
    product_model: 'camiseta comum',
    colors: 'branca',
    quantity: 10,
    fabrics: 'algodão',
    artwork_locations: 'frente',
    artwork_status: 'cliente envia a arte',
    needed_by: '20/11',
  };
  const done = decide({ briefing_patch: complete });
  assert.equal(
    done.trigger,
    'briefing_complete',
    'a complete briefing hands off without asking to build the quote',
  );
  assert.equal(
    done.open_order,
    true,
    'a complete ficha holds its points, so the handoff opens the order',
  );
  assert.doesNotMatch(done.reply_text, /\?/u);
  assert.equal(
    decide({ briefing_patch: complete }, { turn: 15 }).trigger,
    'briefing_complete',
  );
});

test('sends the handoff notice the CRM reserved, and only that one (BOT-03)', async () => {
  const workflow = JSON.parse(await readFile(workflowSnapshot, 'utf8'));
  const byName = new Map(
    workflow.nodes.map((/** @type {any} */ node) => [node.name, node]),
  );
  /** @param {string} source @param {number} [output] */
  const targets = (source, output = 0) =>
    (workflow.connections[source]?.main?.[output] ?? []).map(
      (/** @type {any} */ edge) => edge.node,
    );
  assert.deepEqual(targets('CRM - Registrar handoff (MVP)').sort(), [
    'Pedido não abriu? (MVP)',
    'Preparar aviso de transferência (MVP)',
  ]);
  assert.deepEqual(targets('Aviso de transferência autorizado? (MVP)'), [
    'Enviar aviso pelo chat do site? (MVP)',
  ]);
  // ADR 026: WhatsApp goes to Meta; the site chat shows the notice itself.
  assert.deepEqual(targets('Enviar aviso pelo chat do site? (MVP)', 1), [
    'WhatsApp - Enviar aviso de transferência (MVP)',
  ]);
  assert.deepEqual(targets('Enviar aviso pelo chat do site? (MVP)', 0), [
    'Site - Entregar aviso de transferência (MVP)',
  ]);
  const send = byName.get('WhatsApp - Enviar aviso de transferência (MVP)');
  assert.equal(send.onError, 'continueErrorOutput');
  assert.deepEqual(targets('WhatsApp - Enviar aviso de transferência (MVP)'), [
    'Preparar message.sent do aviso (MVP)',
  ]);
  assert.deepEqual(
    targets('WhatsApp - Enviar aviso de transferência (MVP)', 1),
    ['Preparar envio desconhecido do aviso (MVP)'],
  );

  const handoff = runCodeNode(
    byName.get('Preparar handoff da IA (MVP)').parameters.jsCode,
    {
      conversation_id: 'conversation-1',
      automation_epoch: 2,
      source_revision: 7,
      briefing_patch: {},
      handoff_reason: 'negotiation',
      reasoning: 'Motivo: Perguntou o valor.',
      reply_text: 'Quem passa os valores é um dos nossos vendedores.',
    },
    {},
  );
  assert.deepEqual(handoff.payload.handoff.notice, {
    command_id: 'conversation-1:7:handoff:notice',
    text: 'Quem passa os valores é um dos nossos vendedores.',
  });

  const prepare = byName.get('Preparar aviso de transferência (MVP)').parameters
    .jsCode;
  const whatsapp = { from: '5511999990000', phone_number_id: 'phone-1' };
  const reserved = runCodeNode(
    prepare,
    {
      notice: {
        command_id: 'conversation-1:7:handoff:notice',
        send_authorized: true,
      },
    },
    {
      'Preparar handoff da IA (MVP)': handoff,
      'Normalizar evento WhatsApp (MVP)': whatsapp,
    },
  );
  assert.equal(reserved.send_authorized, true);
  assert.equal(reserved.text, handoff.payload.handoff.notice.text);
  assert.equal(reserved.wa_id, '5511999990000');
  assert.equal(reserved.conversation_id, 'conversation-1');

  const media = runCodeNode(
    byName.get('Preparar handoff de conteúdo (MVP)').parameters.jsCode,
    {
      conversation_id: 'conversation-2',
      automation_epoch: 0,
      source_revision: 1,
    },
    { 'Normalizar evento WhatsApp (MVP)': { message_type: 'document' } },
  );
  assert.match(media.payload.handoff.notice.text, /arquivo/u);
  assert.match(media.payload.handoff.notice.text, /aqui mesmo/u);
  // ADR 026: the site chat cannot carry the seller's reply; it asks for a WhatsApp.
  const siteMedia = runCodeNode(
    byName.get('Preparar handoff de conteúdo (MVP)').parameters.jsCode,
    {
      conversation_id: 'conversation-3',
      automation_epoch: 0,
      source_revision: 1,
    },
    {
      'Normalizar evento WhatsApp (MVP)': {
        message_type: 'video',
        channel: 'site_chat',
      },
    },
  );
  assert.equal(
    siteMedia.payload.handoff.notice.text,
    'Recebi o seu arquivo, obrigada! Um dos nossos vendedores vai continuar o seu atendimento aqui mesmo.',
  );
  assert.equal(
    runCodeNode(
      prepare,
      { notice: { command_id: null, send_authorized: false } },
      {
        'Preparar handoff de conteúdo (MVP)': media,
        'Normalizar evento WhatsApp (MVP)': whatsapp,
      },
    ).send_authorized,
    false,
    'a replay or a spent cap never reaches Meta',
  );
});

test('decision normalizer applies the PO decisions of 30/09 on top of BOT-03', async () => {
  const byName = await workflowNodesByName();
  const jsCode = byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode;
  /** @param {any} output @param {any} [context] */
  const decide = (output, context = {}) =>
    runCodeNode(
      jsCode,
      {
        output: {
          reply_text: 'Resposta da IA',
          briefing_patch: {},
          answer_status: 'none',
          person_request: 'none',
          ...output,
        },
      },
      {
        'Montar contexto da IA (MVP)': {
          conversation_id: 'conversation-1',
          automation_epoch: 1,
          source_revision: 3,
          briefing: {},
          recent_messages: [],
          current_text: '',
          profile_name: '',
          sellers: [],
          message_cap: 15,
          turn: 3,
          name_asks: 2,
          crm_counter: true,
          ...context,
        },
      },
    );

  const cap = decide({}, { turn: 15 });
  assert.equal(cap.handoff_reason, 'iteration_limit');
  assert.match(cap.reasoning, /Limite de 15 mensagens do agente/u);
  assert.equal(
    decide({}, { turn: 15, crm_counter: false }).handoff_reason,
    'low_confidence',
    'a CRM without migration 0025 only knows low_confidence',
  );

  const deferred = decide(
    { answer_status: 'deferred' },
    {
      briefing: { product_type: 'camisetas', next_required_field: 'needed_by' },
    },
  );
  assert.equal(deferred.briefing_patch.needed_by, 'Definir com o vendedor');
  assert.equal(deferred.missing_briefing_fields.includes('needed_by'), false);
  assert.equal(
    decide({ briefing_patch: { fabrics: 'o vendedor indica o tecido' } })
      .briefing_patch.fabrics,
    'Definir com o vendedor',
  );

  const pickup = decide({ briefing_patch: { delivery_mode: 'retirada' } });
  assert.equal(pickup.briefing_patch.pickup_location, 'Loja da Silmer');

  const english = decide(
    { foreign_language: true },
    { current_text: 'hi, do you make t-shirts?' },
  );
  assert.equal(english.trigger, 'foreign_language');
  assert.equal(english.handoff_reason, 'unsupported');
});

test('the bot neither asks to build the quote nor asks the order name (PO, 01/10)', async () => {
  const byName = await workflowNodesByName();
  const prompt = byName.get('Atendente virtual Silmer (MVP)').parameters.options
    .systemMessage;
  assert.match(
    prompt,
    /Nunca pergunte se pode montar o pedido ou o orçamento/u,
  );
  assert.match(prompt, /Nunca pergunte o nome do pedido/u);
  assert.match(
    prompt,
    /pode escolher mais de uma e termine sempre com "ou outro" ou "ou outra"/u,
  );
  assert.doesNotMatch(prompt, /asked_field "order_intent"/u);

  const schema = JSON.parse(
    byName.get('Validar saída do MVP').parameters.inputSchema,
  );
  assert.equal(
    schema.properties.asked_field.enum.includes('order_intent'),
    false,
  );
  assert.equal(
    schema.properties.asked_field.enum.includes('order_name'),
    false,
  );

  const jsCode = byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode;
  /** @param {any} output @param {any} [context] */
  const decide = (output, context = {}) =>
    runCodeNode(
      jsCode,
      {
        output: {
          reply_text: 'Resposta da IA',
          briefing_patch: {},
          answer_status: 'none',
          person_request: 'none',
          ...output,
        },
      },
      {
        'Montar contexto da IA (MVP)': {
          conversation_id: 'conversation-1',
          automation_epoch: 1,
          source_revision: 3,
          briefing: {},
          recent_messages: [],
          current_text: '',
          profile_name: '',
          sellers: ['Marina'],
          message_cap: 15,
          turn: 3,
          name_asks: 2,
          crm_counter: true,
          ...context,
        },
      },
    );

  const start = decide({ asked_field: 'order_name' });
  assert.equal(start.missing_briefing_fields.includes('order_name'), false);
  assert.notEqual(start.briefing_patch.next_required_field, 'order_name');
  assert.equal(
    decide({ briefing_patch: { order_name: 'EC Unidos da Várzea' } })
      .briefing_patch.order_name,
    'EC Unidos da Várzea',
    'an order name the customer volunteers is still kept',
  );

  // ADR 014: the quantity is a ficha point and opens the order; the model's
  // retired flag alone does not.
  const intent = decide(
    { order_intent_confirmed: true, briefing_patch: { quantity: 30 } },
    { current_text: 'quero 30 camisetas para o evento da empresa' },
  );
  assert.equal(intent.open_order, true);
  assert.equal(intent.handoff_required, false);
  assert.equal(intent.briefing_patch.briefing_status, 'quote_collecting');
  const flagOnly = decide(
    { order_intent_confirmed: true },
    { current_text: 'quero fazer uns uniformes' },
  );
  assert.equal(flagOnly.open_order, false);
  assert.equal(flagOnly.briefing_patch.briefing_status, 'collecting');

  const legacy = decide(
    { answer_status: 'unclear' },
    {
      briefing: {
        next_required_field: 'order_intent',
        briefing_status: 'clarifying',
      },
    },
  );
  assert.equal(
    legacy.handoff_required,
    false,
    'a conversation left on the retired quote question has nothing pending',
  );

  const notices = [
    // VND-L02 item 1: the second price question is the one that hands off.
    decide(
      {},
      {
        current_text: 'quanto custa?',
        briefing: { briefing_status: 'price_collecting' },
      },
    ),
    decide(
      { person_request: 'generic' },
      { current_text: 'quero falar com alguém' },
    ),
    decide(
      { person_request: 'named', requested_person_name: 'Marina' },
      { current_text: 'cadê a Marina?' },
    ),
    decide({ handoff_required: true, handoff_reason: 'complaint' }),
    decide({}, { turn: 15 }),
  ].map((decision) => decision.reply_text);
  for (const text of notices) {
    assert.match(text, /vendedor|equipe/u);
    assert.match(text, /aqui mesmo/u);
    assert.doesNotMatch(text, /Quem passa|chamando alguém|Já estou chamando/u);
  }
});

test('a question ignored twice hands off, and news for the ficha is welcome (PO, 01/10)', async () => {
  const byName = await workflowNodesByName();
  const prompt = byName.get('Atendente virtual Silmer (MVP)').parameters.options
    .systemMessage;
  assert.match(
    prompt,
    /"Quero camisa branca!" → "Que legal, e quantas peças você precisa\?"/u,
  );
  assert.match(prompt, /emende a próxima pergunta na mesma frase/u);
  assert.match(prompt, /não comece com "Anotei"/u);
  assert.match(
    prompt,
    /na mensagem seguinte reaja ao que ele contou e pergunte só o nome/u,
  );
  // Plain words for people who just want a nice shirt (PO, 01/10).
  assert.match(prompt, /palavras do dia a dia, nada de termo técnico/u);
  assert.match(
    prompt,
    /não insista na mesma pergunta: pergunte o ponto que o contexto indica/u,
  );
  assert.match(prompt, /Se ele aceitar uma sugestão sua/u);
  assert.match(
    prompt,
    /Só use nomes como silk, sublimação, DTF, transfer, PV, piquet ou fio se o cliente usar primeiro/u,
  );
  assert.doesNotMatch(
    prompt,
    /Malhas: algodão|Técnicas: silk|malha mista tipo PV/u,
  );

  const jsCode = byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode;
  /** @param {any} output @param {any} [context] */
  const decide = (output, context = {}) =>
    runCodeNode(
      jsCode,
      {
        output: {
          reply_text: 'Resposta da IA',
          briefing_patch: {},
          answer_status: 'none',
          person_request: 'none',
          ...output,
        },
      },
      {
        'Montar contexto da IA (MVP)': {
          conversation_id: 'conversation-1',
          automation_epoch: 1,
          source_revision: 3,
          briefing: {},
          recent_messages: [],
          current_text: '',
          profile_name: '',
          sellers: [],
          message_cap: 15,
          turn: 3,
          name_asks: 1,
          crm_counter: true,
          ...context,
        },
      },
    );

  const asked = { next_required_field: 'customer_name' };
  const firstIgnore = decide(
    { answer_status: 'other', asked_field: 'customer_name' },
    { briefing: asked, current_text: 'dtf desbota?' },
  );
  assert.equal(firstIgnore.handoff_required, false);
  assert.equal(firstIgnore.briefing_patch.briefing_status, 'ignored');
  assert.equal(firstIgnore.briefing_patch.next_required_field, 'customer_name');

  const secondIgnore = decide(
    { answer_status: 'other', asked_field: 'customer_name' },
    {
      briefing: { ...asked, briefing_status: 'ignored' },
      current_text: 'bordado fica bom em boné?',
    },
  );
  assert.equal(secondIgnore.trigger, 'ignored_twice');
  assert.equal(secondIgnore.handoff_reason, 'low_confidence');
  assert.match(
    secondIgnore.reasoning,
    /não respondeu à mesma pergunta duas vezes/u,
  );
  assert.match(secondIgnore.reply_text, /vendedores/u);

  const addsInstead = decide(
    {
      answer_status: 'other',
      asked_field: 'customer_name',
      briefing_patch: { product_type: 'camisa', colors: 'branca' },
    },
    {
      briefing: { ...asked, briefing_status: 'ignored' },
      current_text: 'quero camisa branca!',
    },
  );
  assert.equal(
    addsInstead.handoff_required,
    false,
    'a message that adds to the ficha is progress, not an ignored question',
  );
  assert.equal(addsInstead.briefing_patch.colors, 'branca');

  const onlyNotes = decide(
    {
      answer_status: 'other',
      asked_field: 'customer_name',
      briefing_patch: { notes: 'Perguntou sobre bordado em boné' },
    },
    { briefing: { ...asked, briefing_status: 'ignored' } },
  );
  assert.equal(onlyNotes.trigger, 'ignored_twice', 'notes alone add nothing');
  // ADR 024: fabric is asked only once the product is clothing, so the order
  // is already open (quote_).

  const aboutTheField = decide(
    { answer_status: 'question', asked_field: 'colors' },
    {
      briefing: {
        customer_name: 'Ana',
        product_type: 'camisetas',
        next_required_field: 'colors',
        briefing_status: 'ignored',
      },
      current_text: 'qual cor combina com estampa colorida?',
    },
  );
  assert.equal(aboutTheField.handoff_required, false);
  assert.equal(aboutTheField.briefing_patch.briefing_status, 'quote_ignored');

  const skippedWithNews = decide(
    {
      answer_status: 'other',
      asked_field: 'product_type',
      briefing_patch: { colors: 'branca' },
    },
    {
      briefing: { next_required_field: 'product_type' },
      current_text: 'branca',
    },
  );
  assert.equal(skippedWithNews.handoff_required, false);
  assert.equal(
    skippedWithNews.briefing_patch.briefing_status,
    // ADR 014: the colour is a ficha point, so the order opens too (quote_).
    'quote_skipped',
    'a skipped question with news makes the next reply move on',
  );

  const newQuestion = decide(
    { answer_status: 'other', asked_field: 'quantity' },
    { briefing: asked, current_text: 'vocês abrem sábado?' },
  );
  assert.equal(
    newQuestion.briefing_patch.briefing_status,
    'ignored',
    'the model cannot reset an ignored question by asking a different ficha point',
  );
  assert.equal(newQuestion.briefing_patch.next_required_field, 'customer_name');

  const missedThenIgnored = decide(
    { answer_status: 'other', asked_field: 'colors' },
    {
      briefing: {
        product_type: 'camisetas',
        next_required_field: 'colors',
        briefing_status: 'quote_clarifying',
      },
    },
  );
  assert.equal(missedThenIgnored.trigger, 'ignored_twice');
  const ignoredThenUnsure = decide(
    { answer_status: 'undecided', asked_field: 'colors' },
    {
      briefing: {
        product_type: 'camisetas',
        next_required_field: 'colors',
        briefing_status: 'quote_ignored',
      },
    },
  );
  assert.equal(ignoredThenUnsure.trigger, 'two_attempts');

  const contextCode = byName.get('Montar contexto da IA (MVP)').parameters
    .jsCode;
  /** @param {any} inbound */
  const contextPrompt = (inbound) =>
    runCodeNode(
      contextCode,
      {
        conversation_id: 'conversation-1',
        automation_epoch: 1,
        source_revision: 3,
        automation_message_count: 2,
        automation_message_cap: 15,
        sellers: [],
        ...inbound,
      },
      {
        'Normalizar evento WhatsApp (MVP)': {
          from: '5500000000000',
          phone_number_id: 'phone-1',
          text: 'Quero camisa branca!',
          customer_name: '',
        },
      },
    ).prompt;
  const greeting = {
    sender_type: 'ai',
    text: 'Oi! Sou a assistente virtual da Silmer. Qual é o seu nome?',
  };
  // ADR 024: asked at the greeting, the name is asked once more, alone; asked
  // twice, the bot stops.
  assert.match(
    contextPrompt({ briefing: {}, recent_messages: [greeting] }),
    /Nome do cliente: pedido na apresentação e não respondido; agora pergunte só o nome/u,
  );
  assert.match(
    contextPrompt({ briefing: {}, recent_messages: [greeting, greeting] }),
    /Nome do cliente: já pedido duas vezes; não pergunte mais, o vendedor confirma/u,
  );
  assert.match(
    contextPrompt({ briefing: {}, recent_messages: [] }),
    /Nome do cliente: ainda não pedido/u,
  );
  // After a skip the bot moved on to the next point; the skipped one waits (ADR 012).
  assert.match(
    contextPrompt({
      briefing: {
        colors: 'branca',
        next_required_field: 'quantity',
        briefing_status: 'quote_skipped',
      },
      recent_messages: [greeting, greeting],
    }),
    /o cliente pulou product_type \(produto\) e contou outra coisa do pedido; isso fica para o fim da lista, não pergunte agora/u,
  );
  assert.match(
    contextPrompt({
      briefing: { customer_name: 'Júlia' },
      recent_messages: [greeting],
    }),
    /Nome do cliente: já informado/u,
  );
});

// ADR 024: the points the bot asks, in one rhythm. VND-L02 items 2 and 3: the
// fabric (clothing only) and the artwork origin are asked too; technique,
// sizes and collar are only recorded.
const RHYTHM = [
  'product_type',
  'product_model',
  'colors',
  'quantity',
  'fabrics',
  'artwork_locations',
  'artwork_status',
  'needed_by',
];
// A shirt asks every point of the rhythm.
const SHIRT_POINTS = Object.freeze({
  product_type: 'camisetas',
  product_model: 'camiseta comum',
  colors: 'branca',
  quantity: 30,
  fabrics: 'algodão',
  artwork_locations: 'frente',
  artwork_status: 'cliente envia a arte',
  needed_by: '20/11',
});
const GREETING = {
  sender_type: 'ai',
  text: 'Oi! Sou a assistente virtual da Silmer. Qual é o seu nome e o que você quer personalizar?',
};
const NAME_AGAIN = {
  sender_type: 'ai',
  text: 'Que legal que você quer camisetas! Qual é o seu nome?',
};

/** @param {...string} omit */
function shirtPointsWithout(...omit) {
  return Object.fromEntries(
    Object.entries(SHIRT_POINTS).filter(([key]) => !omit.includes(key)),
  );
}

/** Runs the context node for one inbound with the given briefing. */
async function rhythmContext(
  /** @type {any} */ briefing,
  /** @type {any[]} */ recentMessages = [GREETING, NAME_AGAIN],
) {
  const byName = await workflowNodesByName();
  return runCodeNode(
    byName.get('Montar contexto da IA (MVP)').parameters.jsCode,
    {
      conversation_id: 'conversation-1',
      automation_epoch: 1,
      source_revision: 3,
      automation_message_count: 2,
      automation_message_cap: 15,
      sellers: [],
      briefing,
      recent_messages: recentMessages,
    },
    {
      'Normalizar evento WhatsApp (MVP)': {
        from: '5500000000000',
        phone_number_id: 'phone-1',
        text: 'Mensagem do cliente',
        customer_name: '',
      },
    },
  );
}

/** Runs the decision node for one model output and context. */
async function rhythmDecision(
  /** @type {any} */ output,
  /** @type {any} */ context = {},
) {
  const byName = await workflowNodesByName();
  return runCodeNode(
    byName.get('Normalizar decisão da IA (MVP)').parameters.jsCode,
    {
      output: {
        reply_text: 'Resposta da IA',
        briefing_patch: {},
        answer_status: 'none',
        person_request: 'none',
        asked_field: null,
        ...output,
      },
    },
    {
      'Montar contexto da IA (MVP)': {
        conversation_id: 'conversation-1',
        automation_epoch: 1,
        source_revision: 3,
        briefing: {},
        recent_messages: [],
        current_text: '',
        profile_name: '',
        sellers: [],
        message_cap: 15,
        turn: 3,
        crm_counter: true,
        name_asked: true,
        // ADR 024: the name was asked at the greeting and right after; the
        // points are what these tests exercise.
        name_asks: 2,
        ...context,
      },
    },
  );
}

test('confirmed front print is stored and never followed by a print-or-plain question', async () => {
  const current = await rhythmDecision(
    {
      reply_text: 'Você quer a camiseta com estampa ou lisa?',
      asked_field: 'artwork_locations',
      answer_status: 'other',
      briefing_patch: { artwork_status: 'com estampa' },
    },
    {
      briefing: {
        customer_name: 'Ana',
        product_model: 'camiseta comum',
        colors: 'branca',
        quantity: 30,
        fabrics: 'algodão',
        next_required_field: 'artwork_locations',
      },
      current_text: 'Quero estampa na frente.',
    },
  );
  assert.equal(current.briefing_patch.artwork_locations, 'frente');
  assert.equal(current.briefing_patch.artwork_status, undefined);
  assert.equal(current.briefing_patch.artwork_technique, 'com estampa');
  // VND-L02 item 2: where the art comes from is the next point.
  assert.equal(current.briefing_patch.next_required_field, 'artwork_status');
  assert.equal(current.reply_text, 'Você já tem a arte (ou logo) pronta?');

  const previous = await rhythmDecision(
    {
      reply_text: 'Que tipo de camisa você quer? E vai lisa ou com estampa?',
      asked_field: 'product_model',
    },
    {
      briefing: {
        customer_name: 'Ana',
        product_type: 'camisas',
        artwork_locations: 'frente',
      },
      current_text: 'Preciso de camisas para a equipe.',
    },
  );
  assert.equal(previous.briefing_patch.artwork_locations, undefined);
  assert.equal(previous.briefing_patch.next_required_field, 'product_model');
  assert.match(previous.reply_text, /Que tipo de camisa você quer\?/u);
  assert.doesNotMatch(previous.reply_text, /lisa ou com estampa/u);

  // ADR 024: with nothing left, the reply falls back on the question of the
  // product the customer wants to customize.
  const onlyPrint = await rhythmDecision(
    { reply_text: 'E vai lisa ou com estampa?', asked_field: 'product_model' },
    {
      briefing: {
        customer_name: 'Ana',
        product_type: 'bonés',
        artwork_locations: 'frente',
      },
    },
  );
  assert.equal(onlyPrint.briefing_patch.next_required_field, 'product_model');
  assert.equal(
    onlyPrint.reply_text,
    'Qual modelo de boné você quer: trucker (com tela atrás), aba curva, aba reta ou outro?',
  );
});

test('the ficha is the name plus the product points in one rhythm, kept in one place (ADR 012, ADR 024)', async () => {
  const byName = await workflowNodesByName();
  for (const name of [
    'Montar contexto da IA (MVP)',
    'Normalizar decisão da IA (MVP)',
  ]) {
    const declarations = [
      ...byName
        .get(name)
        .parameters.jsCode.matchAll(/const FICHA_RHYTHM = (\[[^\]]*\]);/gu),
    ];
    assert.equal(declarations.length, 1, `${name} declares the rhythm once`);
    assert.deepEqual(JSON.parse(declarations[0][1]), RHYTHM);
  }

  const schema = JSON.parse(
    byName.get('Validar saída do MVP').parameters.inputSchema,
  );
  // The parser also tolerates the fields the bot used to ask, so a model slip
  // cannot fail the execution; the decision node ignores them.
  assert.deepEqual(schema.properties.asked_field.enum, [
    'customer_name',
    ...RHYTHM,
    'sizes',
    'collar',
    'artwork_technique',
    'purpose',
    'purchase_profile',
    'delivery_mode',
    'city_or_postal_code',
    'delivery_address',
    'pickup_location',
    null,
  ]);
  assert.ok('collar' in schema.properties.briefing_patch.properties);

  const prompt = byName.get('Atendente virtual Silmer (MVP)').parameters.options
    .systemMessage;
  assert.match(prompt, /um ponto por mensagem, o que o contexto indicar/u);
  // ADR 024: the name first, then what to customize, never "qual camisa".
  assert.match(
    prompt,
    /pergunte o nome da pessoa e o que ela quer personalizar \(camisetas ou outras roupas, bonés ou outro produto\)\. Não pergunte "qual camisa" antes de saber o produto/u,
  );
  assert.match(
    prompt,
    /Se o cliente não disser o nome, na mensagem seguinte reaja ao que ele contou e pergunte só o nome, por exemplo: "Que legal que você quer camisetas! Qual é o seu nome\?"\. Depois disso, não pergunte mais o nome/u,
  );
  assert.match(
    prompt,
    /product_model: o modelo, só quando o contexto pedir\. Roupa: camiseta comum, manga longa, polo, regata, abadá, baby look ou outro\. Boné: trucker \(com tela atrás\), aba curva, aba reta ou outro\./u,
  );
  assert.doesNotMatch(prompt, /Mochila ou bolsa:|"ecobags"|"mochila saco"/u);
  assert.match(prompt, /artwork_locations: onde vai a estampa/u);
  // ADR 025: the split by audience has its own field, recorded, never asked.
  assert.match(
    prompt,
    /audiences: a divisão da quantidade por público, só quando o cliente dividir, com as palavras dele e só a divisão \("4 masculinas, 3 femininas e 3 infantis"\); a quantidade total vai em quantity\. Baby look é modelo, não público\./u,
  );
  assert.doesNotMatch(prompt, /notes: a divisão por público/u);
  assert.match(
    prompt,
    /needed_by: para quando o cliente precisa\. É desejo do cliente, nunca prazo confirmado/u,
  );
  // Technique, sizes and collar are only recorded. VND-L02 items 2 and 3: the
  // fabric and whether the customer has the art are asked, never an offer to
  // create it (PRD-03).
  assert.match(
    prompt,
    /O QUE SÓ GRAVAR \(nunca pergunte; o vendedor completa\)/u,
  );
  assert.match(
    prompt,
    /- artwork_status: se o cliente já tem a arte \("Você já tem a arte \(ou logo\) pronta\?"\)\. Nunca ofereça criar a arte\./u,
  );
  assert.match(
    prompt,
    /- fabrics: o tecido, só para roupa \("Qual tecido você prefere: algodão, poliéster ou dry fit, ou outro\?"\)/u,
  );
  assert.match(
    prompt,
    /De tecido, o cliente comum só conhece algodão, poliéster e dry fit: fale só deles/u,
  );
  assert.match(
    prompt,
    /Tecido: algodão \(macio, bom para o dia a dia\); poliéster \(leve, bom para estampa bem colorida\); dry fit \(seca rápido, bom para esporte e calor\)/u,
  );
  assert.doesNotMatch(
    prompt,
    /tecido misto|encorpado|A única exceção|confecção que produz|quer que a gente crie/u,
  );
  assert.match(
    prompt,
    /Se o cliente disser que vai lisa ou que não haverá estampa/u,
  );
  assert.match(
    prompt,
    /frases curtas, sem listas longas e sem markdown; no máximo 1 emoji, e raramente/u,
  );
  assert.doesNotMatch(prompt, /par de campos|sempre pergunte/u);
});

test('the context node asks the name first, then the points of the product (ADR 012, ADR 024)', async () => {
  // The name with the greeting, and once more right after, alone.
  const fresh = await rhythmContext({}, []);
  assert.equal(fresh.next_point, 'customer_name', 'the greeting asks the name');
  assert.match(
    fresh.prompt,
    /Como perguntar: apresente-se, pergunte o nome e o que a pessoa quer personalizar: camisetas ou outras roupas, bonés ou outro produto\n/u,
  );
  assert.match(fresh.prompt, /Nome do cliente: ainda não pedido/u);
  assert.doesNotMatch(fresh.prompt, /Se o cliente pular/u);

  const productFirst = await rhythmContext({ product_type: 'bonés' }, []);
  assert.equal(productFirst.next_point, 'customer_name');
  assert.match(
    productFirst.prompt,
    /Como perguntar: apresente-se e pergunte o nome\n/u,
  );

  const nameAgain = await rhythmContext(
    {
      product_type: 'camisetas',
      next_required_field: 'customer_name',
      briefing_status: 'quote_skipped',
    },
    [GREETING],
  );
  assert.equal(nameAgain.next_point, 'customer_name');
  assert.match(
    nameAgain.prompt,
    /Como perguntar: reaja ao que o cliente contou e pergunte só o nome, por exemplo: "Que legal que você quer camisetas! Qual é o seu nome\?"\n/u,
  );
  assert.match(
    nameAgain.prompt,
    /Nome do cliente: pedido na apresentação e não respondido; agora pergunte só o nome/u,
  );

  const askedTwice = await rhythmContext({ product_type: 'camisetas' });
  assert.equal(askedTwice.next_point, 'product_model');
  assert.match(
    askedTwice.prompt,
    /Nome do cliente: já pedido duas vezes; não pergunte mais, o vendedor confirma/u,
  );
  assert.match(
    askedTwice.prompt,
    /Pontos que ainda faltam, nesta ordem: product_model \(modelo\), colors \(cor\), quantity \(quantidade\), fabrics \(tecido\), artwork_locations \(onde vai a estampa\), artwork_status \(arte\), needed_by \(para quando\)\n/u,
    'the name no longer waits in line',
  );

  // The product is the first point, and before it is known the model is not.
  const start = await rhythmContext({ customer_name: 'Júlia' });
  assert.equal(start.next_point, 'product_type');
  assert.match(start.prompt, /Produto: ainda não informado\n/u);
  assert.match(
    start.prompt,
    /Próximo ponto da ficha: product_type \(produto\); pergunte só isso\nComo perguntar: O que você quer personalizar: camisetas ou outras roupas, bonés ou outro produto\?\n/u,
  );
  assert.match(
    start.prompt,
    /Pontos que ainda faltam, nesta ordem: product_type \(produto\), colors \(cor\), quantity \(quantidade\), artwork_locations \(onde vai a estampa\), artwork_status \(arte\), needed_by \(para quando\)\n/u,
  );

  const asked = await rhythmContext({
    customer_name: 'Júlia',
    next_required_field: 'product_type',
  });
  assert.match(
    asked.prompt,
    /Se o cliente pular product_type \(produto\) agora e contar outra coisa do pedido: não insista, pergunte colors \(cor\) e volte a produto depois/u,
  );

  const shirt = await rhythmContext({
    customer_name: 'Júlia',
    product_type: 'camisetas',
  });
  assert.equal(shirt.next_point, 'product_model');
  assert.match(shirt.prompt, /Produto: roupa\n/u);
  assert.match(
    shirt.prompt,
    /Como perguntar: Qual modelo você quer: camiseta comum, manga longa, polo, regata, abadá, baby look ou outro\?\n/u,
  );

  const print = await rhythmContext({
    customer_name: 'Júlia',
    ...shirtPointsWithout('artwork_locations', 'needed_by'),
  });
  assert.equal(print.next_point, 'artwork_locations');
  assert.match(
    print.prompt,
    /Como perguntar: Onde vai a estampa: só na frente, ou também nas costas ou na manga\?\n/u,
  );
  const date = await rhythmContext({
    customer_name: 'Júlia',
    ...shirtPointsWithout('needed_by'),
  });
  assert.equal(date.next_point, 'needed_by');
  assert.match(date.prompt, /Como perguntar: Para quando você precisa\?\n/u);

  const cap = await rhythmContext({
    customer_name: 'Júlia',
    product_type: 'bonés',
    product_model: 'bonés trucker',
    colors: 'preto',
    quantity: 50,
  });
  assert.equal(cap.next_point, 'artwork_locations');
  assert.match(cap.prompt, /Produto: boné\n/u);
  assert.match(
    cap.prompt,
    /Como perguntar: Onde vai a personalização do boné: na frente, na lateral ou atrás\?\n/u,
  );

  // A kit fills what the product defines: an abadá is white, with no model to ask.
  const abada = await rhythmContext({
    customer_name: 'Júlia',
    product_type: 'abadás',
  });
  assert.equal(
    abada.next_point,
    'quantity',
    'the abadá skips model and colour',
  );
  assert.match(
    abada.prompt,
    // VND-L02: the abadá kit gives the fabric, so only the artwork is added.
    /Pontos que ainda faltam, nesta ordem: quantity \(quantidade\), artwork_locations \(onde vai a estampa\), artwork_status \(arte\), needed_by \(para quando\)\n/u,
  );

  const bag = await rhythmContext({
    customer_name: 'Júlia',
    product_type: 'ecobags',
  });
  assert.equal(bag.next_point, 'colors', 'an ecobag already names its model');
  assert.match(bag.prompt, /Produto: mochila ou bolsa\n/u);

  const other = await rhythmContext({
    customer_name: 'Júlia',
    product_type: 'canecas',
    colors: 'branca',
  });
  assert.equal(other.next_point, 'quantity', 'another product has no model');
  assert.match(other.prompt, /Produto: outro produto\n/u);
  assert.match(
    other.prompt,
    /Como perguntar: Quantas unidades você precisa\?\n/u,
  );

  const mixed = await rhythmContext({
    customer_name: 'Júlia',
    product_type: 'camisetas e bonés',
  });
  assert.match(mixed.prompt, /Produto: roupa e boné\n/u);
  assert.match(
    mixed.prompt,
    /Como perguntar: Qual modelo você quer para cada produto\?\n/u,
  );

  const filled = await rhythmContext({
    customer_name: 'Júlia',
    product_model: 'camiseta comum',
    colors: 'Definir com o vendedor',
    quantity: 30,
  });
  assert.equal(
    filled.next_point,
    // VND-L02 item 3: a shirt asks the fabric after the quantity.
    'fabrics',
    'filled and deferred points are skipped, and the model says the product',
  );
  assert.match(filled.prompt, /Nome do cliente: já informado/u);

  const clarifying = await rhythmContext({
    customer_name: 'Júlia',
    product_model: 'camiseta comum',
    next_required_field: 'quantity',
    briefing_status: 'quote_clarifying',
  });
  assert.equal(clarifying.next_point, 'quantity');
  assert.match(
    clarifying.prompt,
    /Próximo ponto da ficha: quantity \(quantidade\); pergunte só isso, de novo, oferecendo 2 ou 3 opções simples\nComo perguntar: Quantas peças você precisa\?\n/u,
  );

  const skipped = await rhythmContext({
    customer_name: 'Júlia',
    colors: 'branca',
    next_required_field: 'quantity',
    briefing_status: 'quote_skipped',
  });
  assert.equal(
    skipped.next_point,
    'quantity',
    'after a skip the rhythm goes on from the point the bot moved to',
  );
  assert.match(
    skipped.prompt,
    /Pontos que ainda faltam, nesta ordem: quantity \(quantidade\), artwork_locations \(onde vai a estampa\), artwork_status \(arte\), needed_by \(para quando\), product_type \(produto\)\n/u,
  );

  const complete = await rhythmContext({
    ...SHIRT_POINTS,
    customer_name: 'Júlia',
  });
  assert.equal(complete.next_point, null);
  assert.match(
    complete.prompt,
    /Próximo ponto da ficha: nenhum, a ficha está completa/u,
  );
  assert.doesNotMatch(complete.prompt, /Como perguntar/u);
  assert.equal(
    (await rhythmContext({ ...SHIRT_POINTS })).next_point,
    null,
    'a name asked twice does not hold the ficha',
  );
});

test('the decision node requires only the name and the points of the product (ADR 012, ADR 024)', async () => {
  const done = await rhythmDecision({
    briefing_patch: {
      ...SHIRT_POINTS,
      customer_name: 'Ana',
      delivery_mode: 'entrega',
    },
  });
  assert.equal(done.trigger, 'briefing_complete');
  assert.deepEqual(
    done.missing_briefing_fields,
    [],
    'technique, sizes and collar are never required',
  );
  assert.equal(
    done.briefing_patch.delivery_mode,
    'entrega',
    'a volunteered field is still kept',
  );

  const noDate = await rhythmDecision({
    briefing_patch: {
      ...shirtPointsWithout('needed_by'),
      customer_name: 'Ana',
    },
  });
  assert.equal(noDate.handoff_required, false, 'the date is required');
  assert.deepEqual(noDate.missing_briefing_fields, ['needed_by']);
  assert.equal(noDate.briefing_patch.next_required_field, 'needed_by');

  const price = await rhythmDecision(
    {},
    {
      current_text: 'quanto fica?',
      briefing: {
        ...shirtPointsWithout('artwork_locations', 'needed_by'),
        fabrics: 'Definir com o vendedor',
        // VND-L02 item 1: the price was asked before, so this one hands off.
        briefing_status: 'quote_price_collecting',
      },
    },
  );
  assert.match(price.reasoning, /Faltam: artwork_locations, needed_by\./u);
  assert.match(price.reasoning, /Nome: não informado\./u);
  assert.match(
    price.reasoning,
    /Para o vendedor definir: fabrics\./u,
    'a field left to the seller shows even when the bot never asks it',
  );

  // ADR 024: the name holds the ficha only while the bot still asks it.
  const nameOnce = await rhythmDecision(
    { briefing_patch: { ...SHIRT_POINTS } },
    { name_asks: 1 },
  );
  assert.equal(nameOnce.handoff_required, false);
  assert.deepEqual(nameOnce.missing_briefing_fields, ['customer_name']);
  assert.equal(nameOnce.briefing_patch.next_required_field, 'customer_name');
  const nameTwice = await rhythmDecision({
    briefing_patch: { ...SHIRT_POINTS },
  });
  assert.equal(nameTwice.trigger, 'briefing_complete');
  assert.match(nameTwice.reasoning, /Nome: não informado\./u);

  const legacy = await rhythmDecision(
    { answer_status: 'unclear' },
    {
      briefing: {
        customer_name: 'Ana',
        next_required_field: 'purchase_profile',
        briefing_status: 'clarifying',
      },
    },
  );
  assert.equal(
    legacy.handoff_required,
    false,
    'a field the bot no longer asks has nothing pending',
  );
  assert.equal(legacy.briefing_patch.next_required_field, 'product_type');
});

test('a cap or another product asks its own points, and removed bags transfer (CHAN-WA-01)', async () => {
  const cap = await rhythmDecision({
    briefing_patch: {
      customer_name: 'Ana',
      product_type: 'bonés',
      product_model: 'trucker',
      colors: 'preto',
      quantity: 50,
      artwork_locations: 'frente',
      artwork_status: 'cliente envia a arte',
      needed_by: '10/12',
    },
  });
  assert.equal(cap.trigger, 'briefing_complete');
  assert.deepEqual(cap.missing_briefing_fields, []);
  assert.equal(
    cap.briefing_patch.product_model,
    'bonés trucker',
    'the model keeps the name of the product for the order item',
  );
  assert.equal(
    cap.briefing_patch.collar,
    'NAO APLICAVEL',
    'a cap has no collar, and the order item needs one',
  );
  // VND-L02 item 2: the artwork is a point of the cap too; the fabric is not.
  assert.equal(cap.ficha_total, 8);
  assert.match(cap.reasoning, /Ficha: 8 de 8 \(100%\)/u);
  assert.match(cap.reasoning, /Dica: boné costuma ser bordado\./u);

  const bagStart = await rhythmDecision(
    { answer_status: 'answered', briefing_patch: { product_type: 'ecobags' } },
    { briefing: { customer_name: 'Ana', next_required_field: 'product_type' } },
  );
  assert.equal(bagStart.handoff_required, true);
  assert.equal(bagStart.handoff_reason, 'unsupported');
  assert.equal(bagStart.briefing_patch, null);
  assert.equal(bagStart.open_order, false);

  const backpack = await rhythmDecision(
    { answer_status: 'answered', briefing_patch: { product_type: 'mochilas' } },
    { briefing: { customer_name: 'Ana', next_required_field: 'product_type' } },
  );
  assert.equal(backpack.handoff_required, true);
  assert.equal(backpack.handoff_reason, 'unsupported');
  assert.equal(backpack.briefing_patch, null);
  assert.equal(backpack.open_order, false);
  const sameName = await rhythmDecision(
    { briefing_patch: { product_model: 'mochila saco' } },
    {
      briefing: {
        customer_name: 'Ana',
        product_type: 'mochilas',
        next_required_field: 'product_model',
      },
    },
  );
  assert.equal(sameName.handoff_required, true);
  assert.equal(sameName.handoff_reason, 'unsupported');
  assert.equal(sameName.briefing_patch, null);
  assert.equal(sameName.open_order, false);

  const regatas = await rhythmDecision(
    {
      answer_status: 'answered',
      briefing_patch: { product_model: '30 regatas' },
    },
    { briefing: { customer_name: 'Ana', next_required_field: 'product_type' } },
  );
  assert.equal(
    regatas.briefing_patch.product_type,
    '30 regatas',
    'the model the customer gives also says the product',
  );
  assert.equal(regatas.briefing_patch.next_required_field, 'colors');

  const polos = await rhythmDecision(
    {
      answer_status: 'answered',
      briefing_patch: { product_type: 'camisas polo' },
    },
    { briefing: { customer_name: 'Ana', next_required_field: 'product_type' } },
  );
  assert.equal(polos.briefing_patch.product_model, 'camisas polo');
  assert.equal(polos.briefing_patch.next_required_field, 'colors');

  const shirts = await rhythmDecision(
    {
      answer_status: 'answered',
      briefing_patch: { product_type: 'camisetas' },
    },
    { briefing: { customer_name: 'Ana', next_required_field: 'product_type' } },
  );
  assert.equal(shirts.briefing_patch.product_model, undefined);
  assert.equal('collar' in shirts.briefing_patch, false);
  assert.equal(shirts.briefing_patch.next_required_field, 'product_model');

  const mugs = await rhythmDecision({
    briefing_patch: {
      customer_name: 'Ana',
      product_type: 'canecas',
      colors: 'branca',
      quantity: 100,
      artwork_locations: 'um lado',
      artwork_status: 'cliente envia a arte',
      needed_by: 'dezembro',
    },
  });
  assert.equal(
    mugs.trigger,
    'briefing_complete',
    'another product has no model',
  );
  assert.equal(
    'collar' in mugs.briefing_patch,
    false,
    'nor a collar it guesses',
  );
  // VND-L02 item 2: the artwork is a point of any product.
  assert.equal(mugs.ficha_total, 7);
  assert.match(
    mugs.reasoning,
    /Dica: caneca, squeeze, garrafa e mouse pad costumam ser sublimação\./u,
  );

  const mixed = await rhythmDecision({
    briefing_patch: {
      customer_name: 'Ana',
      product_type: 'camisetas e bonés',
      colors: 'preto',
    },
  });
  assert.equal('collar' in mixed.briefing_patch, false);
  // VND-L02: clothing in the order asks its fabric, and every order its artwork.
  assert.deepEqual(mixed.missing_briefing_fields, [
    'product_model',
    'quantity',
    'fabrics',
    'artwork_locations',
    'artwork_status',
    'needed_by',
  ]);

  const deferredModel = await rhythmDecision(
    { answer_status: 'deferred' },
    {
      briefing: {
        customer_name: 'Ana',
        product_type: 'bonés',
        next_required_field: 'product_model',
      },
      current_text: 'o modelo o vendedor me indica',
    },
  );
  assert.equal(
    deferredModel.briefing_patch.product_model,
    'Definir com o vendedor',
  );
  assert.equal(deferredModel.briefing_patch.next_required_field, 'colors');
});

test('a kit fills what the product or the technique defines, and the seller gets alerts and hints (ADR 024)', async () => {
  const abada = await rhythmDecision(
    { answer_status: 'answered', briefing_patch: { product_type: 'abadás' } },
    { briefing: { customer_name: 'Ana', next_required_field: 'product_type' } },
  );
  assert.deepEqual(
    {
      product_model: abada.briefing_patch.product_model,
      artwork_technique: abada.briefing_patch.artwork_technique,
      fabrics: abada.briefing_patch.fabrics,
      colors: abada.briefing_patch.colors,
      collar: abada.briefing_patch.collar,
    },
    {
      product_model: 'abadás',
      artwork_technique: 'sublimação total',
      fabrics: 'poliéster',
      colors: 'branca',
      collar: 'regata',
    },
  );
  assert.equal(
    abada.briefing_patch.next_required_field,
    'quantity',
    'no model and no colour to ask',
  );

  // A kit never overwrites the customer, and a conflict goes to the seller.
  const blackAbada = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      // VND-L02 item 1: price_ marks a price asked before, so this one hands off.
      briefing: {
        product_type: 'abadás',
        colors: 'preto',
        briefing_status: 'price_collecting',
      },
    },
  );
  assert.equal(blackAbada.briefing_patch.colors, undefined);
  assert.match(
    blackAbada.reasoning,
    /Atenção: sublimação em peça escura: a sublimação pede peça branca ou clara\./u,
  );

  const fullPrint = await rhythmDecision({
    briefing_patch: {
      product_type: 'camisetas',
      artwork_technique: 'sublimação total',
    },
  });
  assert.equal(fullPrint.briefing_patch.fabrics, 'poliéster');
  assert.equal(fullPrint.briefing_patch.colors, 'branca');
  assert.equal(fullPrint.missing_briefing_fields.includes('colors'), false);

  const cotton = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      briefing: {
        product_type: 'camisetas',
        artwork_technique: 'sublimação total',
        fabrics: 'algodão',
        briefing_status: 'price_collecting',
      },
    },
  );
  assert.match(
    cotton.reasoning,
    /Atenção: sublimação em algodão: a sublimação pede poliéster\./u,
  );

  const mixedAbada = await rhythmDecision({
    briefing_patch: { product_type: 'camisetas e abadás' },
  });
  assert.equal(
    'colors' in mixedAbada.briefing_patch,
    false,
    'a kit applies only when every product of the order is it',
  );

  for (const model of [
    'regata',
    'Camisa regata dry fit',
    'abadá',
    '30 regatas e 20 abadás',
  ]) {
    const decision = await rhythmDecision({
      briefing_patch: { product_model: model },
    });
    assert.equal(decision.briefing_patch.collar, 'regata', model);
  }
  for (const model of ['polo', 'Camisa polo', '20 polos']) {
    const decision = await rhythmDecision({
      briefing_patch: { product_model: model },
    });
    assert.equal(decision.briefing_patch.collar, 'gola polo', model);
  }
  for (const model of ['camisetas e regatas', 'camiseta e polo']) {
    const decision = await rhythmDecision({
      briefing_patch: { product_model: model },
    });
    assert.equal('collar' in decision.briefing_patch, false, model);
  }
  assert.equal(
    (
      await rhythmDecision(
        { briefing_patch: { product_model: 'regata' } },
        { briefing: { collar: 'gola V' } },
      )
    ).briefing_patch.collar,
    undefined,
    'a collar the customer gave is never overwritten',
  );

  const personal = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      briefing: {
        product_type: 'camisetas',
        customizations: 'nome e número nas costas',
        notes: 'Divisão por público: 4 masculinas, 3 femininas, 3 infantis',
        briefing_status: 'price_collecting',
      },
    },
  );
  assert.match(
    personal.reasoning,
    /Dica: personalização individual: pedir a lista de nomes, números e tamanhos; divisão por público: cada público vira um item\./u,
  );

  // ADR 025: the split rides its own field, which the CRM turns into items.
  const split = await rhythmDecision(
    {
      briefing_patch: {
        product_type: 'camisetas',
        quantity: 10,
        audiences: '4 masculinas, 3 femininas e 3 infantis',
      },
    },
    { current_text: '10 camisetas: 4 masculinas, 3 femininas e 3 infantis' },
  );
  assert.equal(
    split.briefing_patch.audiences,
    '4 masculinas, 3 femininas e 3 infantis',
    'the decision node keeps the split for the CRM',
  );
  const splitPrice = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      briefing: {
        product_type: 'camisetas',
        audiences: '5 masculinas e 5 femininas',
        briefing_status: 'price_collecting',
      },
    },
  );
  assert.match(
    splitPrice.reasoning,
    /Dica: divisão por público: cada público vira um item\./u,
  );
  assert.equal(
    splitPrice.missing_briefing_fields.includes('audiences'),
    false,
    'the split is never asked',
  );

  const embroidery = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      briefing: {
        product_type: 'bonés',
        artwork_technique: 'bordado com foto',
        briefing_status: 'price_collecting',
      },
    },
  );
  assert.match(
    embroidery.reasoning,
    /Atenção: bordado com foto ou arte muito colorida: conferir se dá para bordar\./u,
  );
});

test('the decision node picks the next point from the rhythm (ADR 012, ADR 024)', async () => {
  /** @param {any} output @param {any} [context] */
  const next = async (output, context) =>
    (await rhythmDecision(output, context)).briefing_patch.next_required_field;

  assert.equal(
    await next({}, { name_asks: 0 }),
    'customer_name',
    'the greeting asks the name',
  );
  assert.equal(
    await next({}, { briefing: { customer_name: 'Ana' } }),
    'product_type',
  );
  assert.equal(
    await next(
      { briefing_patch: { product_model: 'camiseta comum', colors: 'preta' } },
      { briefing: { customer_name: 'Ana' } },
    ),
    'quantity',
    'points the message fills are skipped',
  );
  assert.equal(
    await next(
      { answer_status: 'deferred' },
      {
        briefing: {
          customer_name: 'Ana',
          ...shirtPointsWithout('artwork_locations', 'needed_by'),
          next_required_field: 'artwork_locations',
        },
      },
    ),
    'needed_by',
    'a point left to the seller is not asked again',
  );
  assert.equal(
    await next(
      { answer_status: 'other' },
      {
        current_text: 'vocês abrem sábado?',
        briefing: { customer_name: 'Ana', next_required_field: 'quantity' },
      },
    ),
    'quantity',
    'the point just asked comes first until it is answered',
  );
  assert.equal(
    await next(
      { asked_field: 'fabrics' },
      { briefing: { customer_name: 'Ana' } },
    ),
    'product_type',
    'the model cannot move the rhythm to a field the bot only records',
  );
  assert.equal(
    await next(
      { asked_field: 'needed_by' },
      { briefing: { customer_name: 'Ana' } },
    ),
    'product_type',
    'the workflow repairs a model question that skips earlier missing points',
  );

  const firstMiss = await rhythmDecision(
    { answer_status: 'unclear' },
    {
      briefing: {
        customer_name: 'Ana',
        product_type: 'camisetas',
        next_required_field: 'colors',
      },
    },
  );
  assert.equal(firstMiss.briefing_patch.briefing_status, 'quote_clarifying');
  assert.equal(firstMiss.briefing_patch.next_required_field, 'colors');

  // ADR 024: the customer told the product but not the name: the name, alone.
  const nameAgain = await rhythmDecision(
    { answer_status: 'other', briefing_patch: { product_type: 'camisetas' } },
    {
      name_asks: 1,
      current_text: 'quero camisetas',
      briefing: { next_required_field: 'customer_name' },
    },
  );
  assert.equal(nameAgain.briefing_patch.next_required_field, 'customer_name');
  assert.equal(nameAgain.briefing_patch.briefing_status, 'quote_skipped');
  const thenPoints = await rhythmDecision(
    { answer_status: 'other', briefing_patch: { product_model: 'polo' } },
    {
      name_asks: 2,
      current_text: 'polo',
      briefing: {
        product_type: 'camisetas',
        next_required_field: 'customer_name',
      },
    },
  );
  assert.equal(
    thenPoints.briefing_patch.next_required_field,
    'colors',
    'asked twice, the name is not asked again',
  );
});

test('a skipped point waits at the end of the rhythm (ADR 011 item 8, ADR 012)', async () => {
  const skip = await rhythmDecision(
    { answer_status: 'other', briefing_patch: { colors: 'branca' } },
    {
      current_text: 'quero branca',
      briefing: { customer_name: 'Ana', next_required_field: 'product_type' },
    },
  );
  assert.equal(skip.handoff_required, false);
  // ADR 014: the colour is a ficha point, so the order opens (quote_).
  assert.equal(skip.briefing_patch.briefing_status, 'quote_skipped');
  assert.equal(
    skip.briefing_patch.next_required_field,
    'quantity',
    'the reply after a skip moves on to the next point',
  );

  const after = await rhythmDecision(
    { answer_status: 'answered', briefing_patch: { quantity: 30 } },
    {
      briefing: {
        customer_name: 'Ana',
        colors: 'branca',
        next_required_field: 'quantity',
        briefing_status: 'skipped',
      },
    },
  );
  assert.equal(after.briefing_patch.briefing_status, 'quote_collecting');
  assert.equal(after.briefing_patch.next_required_field, 'artwork_locations');

  const back = await rhythmDecision(
    { answer_status: 'answered', briefing_patch: { needed_by: 'dezembro' } },
    {
      briefing: {
        customer_name: 'Ana',
        colors: 'branca',
        quantity: 30,
        artwork_locations: 'frente',
        next_required_field: 'needed_by',
        briefing_status: 'collecting',
      },
    },
  );
  assert.equal(
    back.briefing_patch.next_required_field,
    'product_type',
    'then the bot comes back to the skipped point',
  );

  // VND-L02: the fabric is a point now; the news is the sizes, only recorded.
  const onlyOneLeft = await rhythmDecision(
    { answer_status: 'other', briefing_patch: { sizes: '10 M, 20 G' } },
    {
      briefing: {
        ...shirtPointsWithout('needed_by'),
        customer_name: 'Ana',
        next_required_field: 'needed_by',
      },
    },
  );
  assert.equal(onlyOneLeft.briefing_patch.briefing_status, 'quote_skipped');
  assert.equal(onlyOneLeft.briefing_patch.next_required_field, 'needed_by');
});

test('an asked_field outside the ficha neither breaks the parser nor moves the rhythm (ADR 012)', async () => {
  const byName = await workflowNodesByName();
  const schema = JSON.parse(
    byName.get('Validar saída do MVP').parameters.inputSchema,
  );
  assert.ok(schema.properties.asked_field.enum.includes('purpose'));

  const slip = await rhythmDecision(
    { answer_status: 'question', asked_field: 'purpose' },
    {
      current_text: 'serve pra evento?',
      briefing: {
        customer_name: 'Ana',
        product_model: 'camiseta comum',
        next_required_field: 'colors',
      },
    },
  );
  assert.equal(slip.handoff_required, false);
  assert.equal(slip.briefing_patch.next_required_field, 'colors');
  assert.equal(slip.missing_briefing_fields.includes('purpose'), false);
});

test('quantity and sizes sent together keep both, and the sizes are only recorded (ADR 024)', async () => {
  const together = await rhythmDecision(
    {
      answer_status: 'answered',
      briefing_patch: { quantity: 30, sizes: '5 P, 10 M, 15 G' },
    },
    {
      current_text: '30 peças, 5 P, 10 M, 15 G',
      briefing: {
        customer_name: 'Ana',
        product_model: 'camiseta comum',
        colors: 'preta',
        next_required_field: 'quantity',
      },
    },
  );
  assert.equal(together.briefing_patch.quantity, 30);
  assert.equal(together.briefing_patch.sizes, '5 P, 10 M, 15 G');
  // VND-L02 items 2 and 3: the fabric comes right after the quantity.
  assert.deepEqual(together.missing_briefing_fields, [
    'fabrics',
    'artwork_locations',
    'artwork_status',
    'needed_by',
  ]);
  assert.equal(together.briefing_patch.next_required_field, 'fabrics');
});

test('something already going on elsewhere calls a seller at once (ADR 013)', async () => {
  const byName = await workflowNodesByName();
  assert.match(
    byName.get('Atendente virtual Silmer (MVP)').parameters.options
      .systemMessage,
    /PEDIDO DO ZERO[\s\S]*a camisa, o boné ou o produto do post[\s\S]*me manda por e-mail/u,
  );
  assert.match(
    byName.get('Validar saída do MVP').parameters.inputSchema,
    /"external_context"/u,
  );

  for (const text of [
    'Quero a camisa do post',
    'quero essa camisa',
    'quero esse boné',
    'Pode me enviar por e-mail?',
    'me manda no whatsapp por favor',
    'vi no story, ainda tem?',
    'https://www.instagram.com/p/abc quero essa',
    'Tem pronta entrega?',
    'pode me ligar?',
    'Já falei com a moça da loja sobre as camisas',
  ]) {
    const decision = await rhythmDecision(
      { order_intent_confirmed: true, external_context: false },
      { current_text: text, name_asks: 0 },
    );
    assert.equal(decision.trigger, 'external_context', text);
    assert.equal(decision.handoff_required, true, text);
    assert.equal(decision.handoff_reason, 'human_requested', text);
    assert.match(decision.reply_text, /vendedores/u, text);
    assert.equal(
      decision.open_order,
      false,
      'something that already exists opens no new order: ' + text,
    );
    assert.match(
      decision.reasoning,
      // ADR 024: before the product is known, the ficha has the common points and the name
      // (VND-L02: the artwork is one of them).
      /Não é um pedido do zero[\s\S]*Ficha: 0 de 7 \(0%\)/u,
      text,
    );
  }

  const flagged = await rhythmDecision(
    { external_context: true },
    { current_text: 'quero igual ao pedido do ano passado' },
  );
  assert.equal(flagged.trigger, 'external_context');

  for (const text of [
    'Vi vocês no Instagram e quero fazer 20 camisetas pro time',
    'preciso das camisas prontas até dia 20',
    'com nome e o número nas costas',
    'Quero 30 camisetas para o posto de saúde',
    'quero gola V',
  ]) {
    const decision = await rhythmDecision(
      { external_context: false },
      { current_text: text },
    );
    assert.equal(decision.trigger, null, text);
  }

  // VND-L02 item 1: a first price question is deferred, so the post calls the
  // seller; a second one keeps its reason.
  assert.equal(
    (
      await rhythmDecision(
        { external_context: true },
        { current_text: 'quanto custa a camisa do post?' },
      )
    ).trigger,
    'external_context',
  );
  const price = await rhythmDecision(
    { external_context: true },
    {
      current_text: 'quanto custa a camisa do post?',
      briefing: { briefing_status: 'price_collecting' },
    },
  );
  assert.equal(price.trigger, 'price', 'a price question keeps its reason');

  const midway = await rhythmDecision(
    { external_context: true },
    {
      current_text: 'na verdade é igual à que vocês postaram ontem',
      briefing: {
        product_model: 'camiseta comum',
        colors: 'azul',
        quantity: 20,
        briefing_status: 'quote_collecting',
        next_required_field: 'artwork_locations',
      },
    },
  );
  assert.equal(midway.trigger, 'external_context');
  assert.equal(
    midway.open_order,
    true,
    'an order already opened stays open for the seller',
  );
  // The model says the product, which the workflow records; the name was asked twice (ADR 024).
  // VND-L02: a shirt has 8 points (fabric and artwork added).
  assert.match(midway.reasoning, /Ficha: 4 de 8 \(50%\)/u);
});

test('the summary measures how much of the ficha the bot filled (ADR 013, ADR 024)', async () => {
  const complete = await rhythmDecision(
    { answer_status: 'answered' },
    { briefing: { ...SHIRT_POINTS, customer_name: 'Ana' } },
  );
  // VND-L02 items 2 and 3: the name plus 8 points of a shirt.
  assert.equal(complete.trigger, 'briefing_complete');
  assert.equal(complete.ficha_filled, 9);
  assert.equal(complete.ficha_total, 9);
  assert.match(complete.reasoning, /Ficha: 9 de 9 \(100%\)/u);

  const deferred = await rhythmDecision(
    { answer_status: 'answered' },
    {
      briefing: {
        ...SHIRT_POINTS,
        needed_by: 'Definir com o vendedor',
        customer_name: 'Ana',
      },
    },
  );
  assert.equal(deferred.trigger, 'briefing_complete');
  assert.equal(
    deferred.ficha_filled,
    8,
    'a point left to the seller is not filled by the bot',
  );
  assert.match(deferred.reasoning, /Ficha: 8 de 9 \(89%\)/u);

  const half = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      name_asks: 1,
      // VND-L02 item 1: the price was asked before, so this one hands off.
      briefing: {
        ...shirtPointsWithout('artwork_locations', 'needed_by'),
        briefing_status: 'quote_price_collecting',
      },
    },
  );
  assert.equal(half.trigger, 'price');
  assert.equal(half.ficha_filled, 6);
  assert.match(half.reasoning, /Ficha: 6 de 9 \(67%\)/u);

  const reply = await rhythmDecision(
    { answer_status: 'answered', briefing_patch: { colors: 'preta' } },
    { briefing: { product_model: 'polo' } },
  );
  assert.equal(reply.handoff_required, false);
  assert.equal(
    reply.ficha_filled,
    3,
    'the product from the polo, the model and the colour; the collar is not a point',
  );

  const cap = await rhythmDecision(
    { asks_price: true },
    {
      current_text: 'quanto fica?',
      briefing: {
        product_type: 'bonés',
        colors: 'preto',
        quantity: 50,
        briefing_status: 'price_collecting',
      },
    },
  );
  // VND-L02: a cap asks its artwork, never a fabric.
  assert.equal(cap.ficha_total, 7, 'a cap counts its own points');
  assert.match(cap.reasoning, /Ficha: 3 de 7 \(43%\)/u);
});

test('"com estampa" is the technique, never where the art comes from, and neither is asked (ADR 012, ADR 024)', async () => {
  // DEV 01/10, KPI-01: "com estampa" answered the artwork point by mistake.
  const typeAnswer = await rhythmDecision(
    {
      answer_status: 'answered',
      briefing_patch: {
        product_model: 'camiseta comum',
        artwork_status: 'com estampa',
        artwork_technique: 'estampada',
      },
    },
    {
      current_text: 'camiseta comum, com estampa',
      briefing: {
        customer_name: 'Dudu',
        product_type: 'camisetas',
        briefing_status: 'quote_collecting',
        next_required_field: 'product_model',
      },
    },
  );
  assert.equal(typeAnswer.briefing_patch.artwork_status, undefined);
  assert.equal(typeAnswer.briefing_patch.artwork_technique, 'estampada');
  assert.equal(
    typeAnswer.missing_briefing_fields.includes('artwork_status'),
    true,
    'VND-L02 item 2: where the art comes from is still asked in its turn',
  );
  assert.equal(typeAnswer.briefing_patch.next_required_field, 'colors');

  for (const printOnly of [
    'com estampa',
    'estampada',
    'bordado',
    'personalizada',
    'sim',
  ]) {
    const decision = await rhythmDecision({
      briefing_patch: { artwork_status: printOnly },
    });
    assert.equal(decision.briefing_patch.artwork_status, undefined, printOnly);
    assert.equal(
      decision.briefing_patch.artwork_technique,
      printOnly,
      printOnly,
    );
  }
  const keepsTechnique = await rhythmDecision(
    { briefing_patch: { artwork_status: 'com estampa' } },
    { briefing: { artwork_technique: 'bordada' } },
  );
  assert.equal(keepsTechnique.briefing_patch.artwork_technique, undefined);

  // VND-L02 item 2: the origin is kept as one of the phrases both parsers (this
  // node and the CRM briefingToFicha) read; not having the art yet is the
  // seller's call, never "Silmer cria a arte" (PRD-03).
  for (const [origin, canonical] of [
    ['já tem a logo', 'cliente envia a arte'],
    ['vai mandar a arte depois', 'cliente envia a arte'],
    ['quer que a Silmer crie', 'Silmer cria a arte'],
    ['precisa de arte', 'Definir com o vendedor'],
    ['sem aplicação', 'sem estampa'],
    ['não quer estampa', 'sem estampa'],
    ['Definir com o vendedor', 'Definir com o vendedor'],
  ]) {
    const decision = await rhythmDecision({
      briefing_patch: { artwork_status: origin },
    });
    assert.equal(decision.briefing_patch.artwork_status, canonical, origin);
  }
});

test('the pending order opens at the first real point of the ficha (ADR 014)', async () => {
  const contract = await fixture('contract-v1.json');
  const byName = await workflowNodesByName();

  // The name alone does not open it.
  const nameOnly = await rhythmDecision(
    { answer_status: 'none', briefing_patch: { customer_name: 'Carla' } },
    { current_text: 'Oi, sou a Carla', name_asks: 0 },
  );
  assert.equal(nameOnly.open_order, false);
  assert.equal(nameOnly.briefing_patch.briefing_status, 'collecting');

  // Nor does a point left to the seller, asked or volunteered.
  const deferred = await rhythmDecision(
    { answer_status: 'deferred' },
    {
      briefing: {
        customer_name: 'Carla',
        next_required_field: 'product_model',
      },
      current_text: 'o vendedor me indica',
    },
  );
  assert.equal(deferred.briefing_patch.product_model, 'Definir com o vendedor');
  assert.equal(deferred.open_order, false);
  assert.equal(
    (
      await rhythmDecision(
        { briefing_patch: { fabrics: 'o vendedor decide' } },
        { current_text: 'o tecido o vendedor decide' },
      )
    ).open_order,
    false,
  );

  // The first real point opens it, whichever of the seven it is.
  for (const [field, value] of Object.entries(SHIRT_POINTS)) {
    const first = await rhythmDecision(
      { answer_status: 'answered', briefing_patch: { [field]: value } },
      { briefing: { customer_name: 'Carla' }, current_text: String(value) },
    );
    assert.equal(first.open_order, true, field);
    assert.match(first.briefing_patch.briefing_status, /^quote_/u, field);
  }

  // A point the ficha already holds keeps asking, and once opened it stays,
  // even if a later answer leaves that point to the seller.
  assert.equal(
    (
      await rhythmDecision(
        { answer_status: 'question' },
        { briefing: { quantity: 30, next_required_field: 'artwork_status' } },
      )
    ).open_order,
    true,
  );
  const stays = await rhythmDecision(
    { briefing_patch: { product_model: 'o vendedor escolhe' } },
    {
      briefing: {
        product_model: 'camiseta comum',
        briefing_status: 'quote_collecting',
      },
    },
  );
  assert.equal(stays.open_order, true);

  // What is not an order from scratch never opens one (ADR 013)...
  const external = await rhythmDecision(
    { external_context: true, briefing_patch: { quantity: 10 } },
    { current_text: 'Quero 10 da camisa do Outubro Rosa que vocês postaram' },
  );
  assert.equal(external.trigger, 'external_context');
  assert.equal(external.open_order, false);

  // ...but any other handoff opens it when the ficha holds a point.
  // VND-L02 item 1: the second price question hands off.
  const price = await rhythmDecision(
    { briefing_patch: { quantity: 100 } },
    {
      current_text: 'Umas 100. Quanto fica cada?',
      briefing: { briefing_status: 'price_collecting' },
    },
  );
  assert.equal(price.trigger, 'price');
  assert.equal(price.open_order, true);
  const named = await rhythmDecision(
    { person_request: 'named', requested_person_name: 'Vendedora Teste' },
    {
      briefing: { quantity: 30, customer_name: 'Ana' },
      current_text: 'quero falar com a Vendedora Teste',
      sellers: ['Vendedora'],
    },
  );
  assert.equal(named.handoff_required, true);
  assert.equal(named.open_order, true);
  const complaintFirst = await rhythmDecision(
    { handoff_required: true, handoff_reason: 'complaint' },
    { current_text: 'vocês demoraram muito pra responder' },
  );
  assert.equal(complaintFirst.handoff_required, true);
  assert.equal(complaintFirst.open_order, false);

  const handoff = runCodeNode(
    byName.get('Preparar handoff da IA (MVP)').parameters.jsCode,
    price,
    {},
  );
  assert.equal(handoff.payload.open_order, true);
  assert.equal(validateEvent(handoff.payload, contract), true);

  // Unsupported media hands off without changing or opening an order.
  const media = byName.get('Preparar handoff de conteúdo (MVP)').parameters
    .jsCode;
  /** @param {any} briefing */
  const mediaHandoff = (briefing) =>
    runCodeNode(
      media,
      {
        conversation_id: 'conversation-3',
        automation_epoch: 1,
        source_revision: 4,
        briefing,
      },
      { 'Normalizar evento WhatsApp (MVP)': { message_type: 'image' } },
    ).payload;
  assert.equal(mediaHandoff({ colors: 'azul' }).open_order, false);
  assert.equal(mediaHandoff({ customer_name: 'Ana' }).open_order, false);
  assert.equal(
    mediaHandoff({ sizes: 'Definir com o vendedor' }).open_order,
    false,
  );
  assert.equal(
    mediaHandoff({ briefing_status: 'quote_collecting' }).open_order,
    false,
  );
  assert.equal(mediaHandoff(undefined).open_order, false);
  assert.equal(validateEvent(mediaHandoff({ colors: 'azul' }), contract), true);
});

test('CP-T04: the agent targets one order, switches briefing, and transfers ambiguous turns', async () => {
  const nodes = await workflowNodesByName();
  const contextCode = nodes.get('Montar contexto da IA (MVP)').parameters
    .jsCode;
  const decisionCode = nodes.get('Normalizar decisão da IA (MVP)').parameters
    .jsCode;
  const handoffCode = nodes.get('Preparar handoff da IA (MVP)').parameters
    .jsCode;
  const subjects = [
    {
      subject_id: 'subject-shirt',
      order_id: 'order-shirt',
      order_number: 'PED-101',
      order_status: 'pendente',
      kind: 'pedido',
      is_current: true,
      selected_source: 'agent',
      briefing: { product_type: 'camisetas', quantity: 30 },
    },
    {
      subject_id: 'subject-cap',
      order_id: 'order-cap',
      order_number: 'PED-102',
      order_status: 'pendente',
      kind: 'pedido',
      is_current: false,
      selected_source: null,
      briefing: { product_type: 'bonés', quantity: 12 },
    },
  ];
  /** @param {any} inbound @param {string} text */
  const context = (inbound, text) =>
    runCodeNode(contextCode, inbound, {
      'CRM - Registrar inbound (MVP)': inbound,
      'Normalizar evento WhatsApp (MVP)': {
        channel: 'whatsapp',
        from: '5527900000001',
        phone_number_id: 'phone-1',
        message_type: 'text',
        text,
      },
    });
  const base = {
    conversation_id: 'conversation-1',
    automation_epoch: 2,
    source_revision: 7,
    automation_message_count: 2,
    automation_message_cap: 15,
    recent_messages: [
      { sender_type: 'customer', text: 'Conversa de outro pedido' },
    ],
    sellers: [],
    subjects,
  };
  const shirt = context(
    { ...base, source_subject_ids: ['subject-shirt'] },
    'As camisetas serão azuis',
  );
  assert.deepEqual(
    [
      shirt.target_subject_id,
      shirt.target_order_id,
      shirt.briefing.product_type,
    ],
    ['subject-shirt', 'order-shirt', 'camisetas'],
  );
  assert.deepEqual(shirt.recent_messages, []);
  const cap = context(
    { ...base, source_revision: 8, source_subject_ids: ['subject-cap'] },
    'Os bonés serão pretos',
  );
  assert.deepEqual(
    [cap.target_subject_id, cap.target_order_id, cap.briefing.product_type],
    ['subject-cap', 'order-cap', 'bonés'],
  );
  const numbered = context(
    { ...base, source_subject_ids: [] },
    'Sobre o PED-102: bonés pretos',
  );
  assert.equal(numbered.target_order_id, 'order-cap');
  const transcribedNumber = runCodeNode(
    contextCode,
    { ...base, source_subject_ids: [] },
    {
      'CRM - Registrar inbound (MVP)': { ...base, source_subject_ids: [] },
      'Normalizar evento WhatsApp (MVP)': {
        channel: 'whatsapp',
        from: '5527900000001',
        media_kind: 'audio',
        message_type: 'audio',
        phone_number_id: 'phone-1',
        text: '',
      },
      'OpenAI - Transcrever áudio (MVP)': {
        text: 'Sobre o PED-102: bonés pretos',
      },
    },
  );
  assert.equal(transcribedNumber.target_order_id, 'order-cap');

  const newOrderRequest = context(
    { ...base, subjects: [subjects[0]], source_subject_ids: [] },
    'Quero fazer outro pedido de bonés',
  );
  assert.equal(newOrderRequest.target_ambiguous, true);
  assert.equal(newOrderRequest.target_order_id, null);
  assert.deepEqual(newOrderRequest.briefing, {});

  const ambiguous = context(
    { ...base, source_subject_ids: [] },
    'Quero mudar a quantidade',
  );
  assert.equal(ambiguous.target_ambiguous, true);
  assert.deepEqual(ambiguous.briefing, {});
  const confirmedCap = { ...subjects[1], order_status: 'confirmado' };
  const mixedOrders = {
    ...base,
    subjects: [subjects[0], confirmedCap],
    source_subject_ids: [],
  };
  const mixedAmbiguous = context(mixedOrders, 'Quero mudar a quantidade');
  assert.equal(mixedAmbiguous.target_ambiguous, true);
  assert.equal(mixedAmbiguous.target_order_id, null);
  assert.deepEqual(mixedAmbiguous.briefing, {});
  const mixedPendingNumber = context(
    mixedOrders,
    'Sobre o PED-101: mudar a quantidade',
  );
  assert.equal(mixedPendingNumber.target_order_id, 'order-shirt');
  assert.equal(mixedPendingNumber.target_ambiguous, false);
  const mixedConfirmedNumber = context(
    mixedOrders,
    'Sobre o PED-102: mudar a quantidade',
  );
  assert.equal(mixedConfirmedNumber.target_ambiguous, true);
  assert.equal(mixedConfirmedNumber.target_order_id, null);
  const humanNumberConflict = context(
    {
      ...base,
      subjects: [{ ...subjects[0], selected_source: 'human' }, subjects[1]],
      source_subject_ids: [],
    },
    'Sobre o PED-102: mudar a quantidade',
  );
  assert.equal(humanNumberConflict.target_ambiguous, true);
  assert.equal(humanNumberConflict.target_order_id, null);
  const output = {
    output: {
      reply_text: 'Resposta',
      briefing_patch: { quantity: 50 },
      answer_status: 'answered',
      person_request: 'none',
    },
  };
  const decision = runCodeNode(decisionCode, output, {
    'Montar contexto da IA (MVP)': ambiguous,
  });
  assert.equal(decision.handoff_required, true);
  assert.equal(decision.briefing_patch, null);
  assert.equal(decision.open_order, false);
  const newOrderDecision = runCodeNode(decisionCode, output, {
    'Montar contexto da IA (MVP)': newOrderRequest,
  });
  assert.equal(newOrderDecision.handoff_required, true);
  assert.equal(newOrderDecision.briefing_patch, null);
  assert.equal(newOrderDecision.open_order, false);
  const handoff = runCodeNode(handoffCode, decision, {});
  assert.equal(handoff.payload.target_contract, 'subject-v1');
  assert.equal('briefing_patch' in handoff.payload, false);
  assert.equal('subject_id' in handoff.payload, false);
  assert.equal('order_id' in handoff.payload, false);
  // CP-16: the CRM asks the seller to classify the turn only for a
  // subject-v1 low_confidence handoff without a target; pin that mapping.
  assert.equal(decision.trigger, 'subject_ambiguous');
  assert.equal(decision.handoff_reason, 'low_confidence');
  assert.equal(handoff.payload.handoff.reason, 'low_confidence');
  assert.equal(newOrderDecision.trigger, 'subject_ambiguous');
  const newOrderHandoff = runCodeNode(handoffCode, newOrderDecision, {});
  assert.equal(newOrderHandoff.payload.handoff.reason, 'low_confidence');
  assert.equal(newOrderHandoff.payload.target_contract, 'subject-v1');
  assert.equal('subject_id' in newOrderHandoff.payload, false);
  const replay = runCodeNode(handoffCode, decision, {});
  assert.deepEqual(
    { ...replay, payload: { ...replay.payload, occurred_at: null } },
    { ...handoff, payload: { ...handoff.payload, occurred_at: null } },
  );

  const nextCycle = context(
    {
      ...base,
      conversation_id: 'conversation-2',
      source_revision: 1,
      subjects: [],
      source_subject_ids: [],
      briefing: {},
    },
    'Quero camisetas novas',
  );
  assert.equal(nextCycle.bootstrap_order, true);
  assert.equal(nextCycle.target_subject_id, null);
  assert.deepEqual(nextCycle.briefing, {});
});
