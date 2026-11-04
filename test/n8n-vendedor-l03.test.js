import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { validateEvent } from '../schemas/fixtures/external/n8n/contract-validator.mjs';

// VND-L03: the Vendedor consumes the CRM contract of the evolution round
// (AGENTE-FAIL-01, AGENTE-OBS-01, INBOX-AUDIO-TRANSCRIPT-01, VND-CTX-01,
// INBOX-HANDOFF-02), reduces the known false positives of ADRs 049 and 051,
// drops "Ótima pergunta!" and closes on the national holidays. The Code nodes
// of the canonical snapshot run here with synthetic customers; the model's
// output is given explicitly, so these tests cover the workflow's own rules.
const snapshot = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const sdk = await readFile(
  new URL(
    '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sdk.js',
    import.meta.url,
  ),
  'utf8',
);
const contract = JSON.parse(
  await readFile(
    new URL(
      '../schemas/fixtures/external/n8n/contract-v1.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const nodes = new Map(
  snapshot.nodes.map((/** @type {any} */ node) => [node.name, node]),
);

const ART_QUESTION = 'Você já tem a arte (ou logo) pronta?';
// Thursday 29/10/2026, 10:00 in São Paulo (UTC-3).
const THURSDAY_MORNING = '2026-10-29T13:00:00.000Z';
const RECEIVED_AT = '2026-10-29T13:00:01.000Z';
// The CRM's user ids (modules/identity-access: "user-" plus 32 hex digits).
const SELLER_ID = 'user-6f1c2a540b7e4c1d9a3f1e2d3c4b5a69';
const OTHER_SELLER_ID = 'user-9a8b7c6d5e4f4a3b8c2d1e0f9a8b7c6d';

/** @param {string} source @param {number} [output] */
function targets(source, output = 0) {
  return (snapshot.connections[source]?.main?.[output] ?? []).map(
    (/** @type {any} */ edge) => edge.node,
  );
}

/**
 * @param {string} name @param {any} item @param {Record<string, any>} upstream
 * @param {any} [binary]
 */
function run(name, item, upstream = {}, binary = undefined) {
  const result = vm.runInNewContext(
    `(() => {\n${nodes.get(name).parameters.jsCode}\n})()`,
    {
      $json: item,
      $input: { item: { json: item, binary } },
      $: (/** @type {string} */ key) => {
        if (!(key in upstream)) throw new Error(`Missing upstream ${key}`);
        return { item: { json: upstream[key] } };
      },
      $execution: { id: 'synthetic-vendedor-l03' },
    },
  );
  return JSON.parse(JSON.stringify(result.json));
}

/**
 * @param {string} text @param {any} [inbound] @param {any} [event]
 * @param {any} [item] @param {Record<string, any>} [extra]
 */
function context(text, inbound = {}, event = {}, item = null, extra = {}) {
  const crm = {
    accepted: true,
    conversation_id: 'conversation-sintetica',
    automation_epoch: 4,
    source_revision: 9,
    automation_message_count: 2,
    automation_message_cap: 15,
    briefing: {},
    recent_messages: [],
    subjects: [],
    source_subject_ids: [],
    // VND-L03 (QA M3): the CRM of this round always answers contact_context
    // (null for a first contact); legacyCrm() below drops it.
    contact_context: null,
    sellers: [
      { id: SELLER_ID, name: 'Bianca' },
      { id: OTHER_SELLER_ID, name: 'Davi' },
    ],
    ...inbound,
  };
  // An undefined key is a CRM that does not send it at all.
  for (const key of Object.keys(crm)) {
    if (crm[key] === undefined) delete crm[key];
  }
  return run('Montar contexto da IA (MVP)', item ?? crm, {
    'CRM - Registrar inbound (MVP)': crm,
    'Preparar inbound CRM (MVP)': { received_at: RECEIVED_AT },
    'Normalizar evento WhatsApp (MVP)': {
      channel: 'whatsapp',
      event_id: 'wamid.sintetico-l03',
      from: '5500000000042',
      phone_number_id: 'synthetic-line',
      text,
      customer_name: 'Cliente Sintético',
      message_type: 'text',
      media_kind: '',
      occurred_at: THURSDAY_MORNING,
      ...event,
    },
    ...extra,
  });
}

/** @param {any} ctx @param {any} [output] */
function decide(ctx, output = {}) {
  return run(
    'Normalizar decisão da IA (MVP)',
    {
      output: {
        reply_text: 'Qual a cor da peça?',
        briefing_patch: {},
        answer_status: 'none',
        person_request: 'none',
        asked_field: null,
        ...output,
      },
    },
    { 'Montar contexto da IA (MVP)': ctx },
  );
}

/** A shirt order with every point but the given ones. @param {...string} without */
function shirtWithout(...without) {
  /** @type {Record<string, any>} */
  const briefing = {
    customer_name: 'Rafa',
    product_type: 'camisetas',
    product_model: 'camiseta comum',
    colors: 'branca',
    quantity: 30,
    fabrics: 'algodão',
    artwork_locations: 'frente',
    artwork_status: 'cliente envia a arte',
    needed_by: '20/11',
    briefing_status: 'quote_collecting',
  };
  for (const field of without) delete briefing[field];
  return briefing;
}

/**
 * Contract §3, as strict as the CRM: these keys only, codes and counts.
 * @param {any} turn
 */
function assertTurn(turn) {
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
  for (const [key, pattern] of /** @type {[string, RegExp][]} */ ([
    ['asked_field', /^[a-z_]{1,48}$/u],
    ['trigger', /^[a-z0-9_]{1,64}$/u],
    ['model', /^[a-z0-9._-]{1,64}$/u],
  ])) {
    assert.ok(turn[key] === null || pattern.test(turn[key]), key);
  }
  assert.ok(
    turn.answer_status === null ||
      [
        'answered',
        'unclear',
        'undecided',
        'question',
        'deferred',
        'other',
        'none',
      ].includes(turn.answer_status),
  );
  assert.ok(
    turn.media_kind === null ||
      ['text', 'image', 'audio', 'sticker'].includes(turn.media_kind),
  );
  assert.ok(Number.isInteger(turn.ficha_total) && turn.ficha_total <= 64);
  assert.ok(
    Number.isInteger(turn.ficha_filled) &&
      turn.ficha_filled >= 0 &&
      turn.ficha_filled <= turn.ficha_total,
  );
  assert.ok(
    turn.latency_ms === null ||
      (Number.isInteger(turn.latency_ms) &&
        turn.latency_ms >= 0 &&
        turn.latency_ms <= 600000),
  );
}

/** The fixture validator predates `turn` (Backend owns it): check the rest. @param {any} payload */
function validCore(payload) {
  const { turn, ...rest } = payload;
  assert.equal(validateEvent(rest, contract), true);
  return turn;
}

// 1 — AGENTE-FAIL-01: a failed model, parser or decision hands off.

test('failure: the agent and the decision node hand off through the error output, within the budget', () => {
  const agent = nodes.get('Atendente virtual Silmer (MVP)');
  assert.equal(agent.onError, 'continueErrorOutput');
  assert.deepEqual(targets(agent.name, 0), ['Normalizar decisão da IA (MVP)']);
  assert.deepEqual(targets(agent.name, 1), [
    'Preparar handoff de falha da IA (MVP)',
  ]);
  const decision = nodes.get('Normalizar decisão da IA (MVP)');
  assert.equal(decision.onError, 'continueErrorOutput');
  assert.deepEqual(targets(decision.name, 1), [
    'Preparar handoff de falha da IA (MVP)',
  ]);
  assert.deepEqual(targets('Preparar handoff de falha da IA (MVP)'), [
    'CRM - Registrar handoff (MVP)',
  ]);

  // The budget: model 30 s with one retry, transcription 30 s, transcript
  // event 5 s with no retry, all under the 120 s execution timeout.
  const model = nodes.get('OpenAI - Modelo do MVP').parameters;
  assert.equal(model.model.value, 'gpt-5.6-luna');
  assert.equal(model.options.timeout, 30000);
  assert.equal(model.options.maxRetries, 1);
  assert.equal(
    nodes.get('OpenAI - Transcrever áudio (MVP)').parameters.options.timeout,
    30000,
  );
  assert.equal(snapshot.settings.executionTimeout, 180);
  const burst = nodes.get('Aguardar mensagens seguidas (MVP)').parameters
    .amount;
  const worst = burst + 30 + 5 + 2 * 30;
  assert.ok(worst < 120, `worst case ${worst} s`);
  assert.match(sdk, /worst case \(an audio with both OpenAI calls/u);
});

test('failure: the handoff is fenced by the turn, says automation_failure and sends a short notice', () => {
  const ctx = context('Quero 30 camisetas', {
    briefing: shirtWithout('colors', 'needed_by'),
  });
  const failure = run(
    'Preparar handoff de falha da IA (MVP)',
    { error: 'Request timed out.' },
    { 'Montar contexto da IA (MVP)': ctx },
  );
  const payload = failure.payload;
  assert.equal(payload.event_type, 'handoff.requested');
  assert.equal(payload.automation_epoch, 4);
  assert.equal(payload.source_revision, 9);
  assert.equal(payload.handoff.reason, 'automation_failure');
  assert.equal(payload.open_order, false);
  assert.equal('briefing_patch' in payload, false);
  assert.equal(
    payload.handoff.notice.text,
    'Recebi a sua mensagem! Um dos nossos vendedores vai continuar o seu atendimento aqui mesmo.',
  );
  assert.doesNotMatch(payload.handoff.notice.text, /Ótima|erro|falh/iu);
  assert.match(payload.handoff.summary, /^Motivo: o assistente automático/u);
  assert.match(payload.handoff.summary, /Ficha: 7 de 9 \(78%\)\./u);
  // The error text (which may quote the model's output) never reaches the CRM.
  assert.doesNotMatch(JSON.stringify(payload), /timed out/u);
  assert.equal(failure.idempotency_key, payload.event_id);
  assert.equal(payload.event_id, 'conversation-sintetica:9:automation-failure');
  const turn = validCore(payload);
  assertTurn(turn);
  assert.equal(turn.trigger, 'automation_failure');
  assert.equal(turn.answer_status, null);

  // The notice the CRM reserves goes out like any other.
  const notice = run(
    'Preparar aviso de transferência (MVP)',
    { notice: { send_authorized: true, command_id: 'n-1' } },
    {
      'Preparar handoff de falha da IA (MVP)': failure,
      'Normalizar evento WhatsApp (MVP)': {
        from: '5500000000042',
        phone_number_id: 'synthetic-line',
      },
    },
  );
  assert.equal(notice.send_authorized, true);
  assert.equal(notice.text, payload.handoff.notice.text);
});

test('failure negative: outside the hours the notice says when a seller answers; a subject target is kept', () => {
  const night = context(
    'oi',
    {
      subjects: [
        {
          subject_id: 'subject-1',
          kind: 'pedido',
          order_id: 'order-1',
          order_number: '07-CRM',
          order_status: 'pendente',
          briefing: { product_type: 'camisetas' },
        },
      ],
    },
    { occurred_at: '2026-10-28T23:01:00.000Z' },
  );
  const payload = run(
    'Preparar handoff de falha da IA (MVP)',
    {},
    { 'Montar contexto da IA (MVP)': night },
  ).payload;
  assert.match(payload.handoff.notice.text, /a partir de amanhã às 9h\.$/u);
  assert.equal(payload.subject_id, 'subject-1');
  assert.equal(payload.order_id, 'order-1');
  validCore(payload);
});

// 2 — AGENTE-OBS-01: the turn's telemetry.

test('telemetry: the reply reservation carries the turn, codes and counts only', () => {
  const ctx = context('Branca', {
    briefing: shirtWithout('colors', 'quantity'),
  });
  assert.equal(ctx.turn_started_at, RECEIVED_AT);
  assert.equal(ctx.turn_media_kind, 'text');
  const decision = decide(ctx, {
    answer_status: 'answered',
    briefing_patch: { colors: 'branca' },
    reply_text: 'Quantas peças você precisa?',
    asked_field: 'quantity',
  });
  assert.equal(decision.asked_point, 'quantity');
  assert.ok(Number.isFinite(Date.parse(decision.decided_at)));
  const reservation = run('Preparar reserva de envio da IA (MVP)', {
    ...decision,
    decided_at: '2026-10-29T13:00:07.000Z',
  });
  const turn = validCore(reservation.payload);
  assertTurn(turn);
  assert.equal(turn.asked_field, 'quantity');
  assert.equal(turn.answer_status, 'answered');
  assert.equal(turn.ficha_total, 9);
  assert.equal(turn.ficha_filled, 8);
  assert.equal(turn.trigger, null);
  assert.equal(turn.model, 'gpt-5.6-luna');
  assert.equal(turn.media_kind, 'text');
  assert.equal(turn.latency_ms, 6000);
  // No customer text, name or phone.
  const serialized = JSON.stringify(turn);
  for (const secret of ['Branca', 'Rafa', '5500000000042', 'Cliente']) {
    assert.doesNotMatch(serialized, new RegExp(secret, 'u'), secret);
  }
});

test('telemetry: a handoff carries its trigger; the latency runs from the receipt to the decision', () => {
  const ctx = context('Quero falar com um atendente');
  const decision = decide(ctx, { person_request: 'generic' });
  const handoff = run('Preparar handoff da IA (MVP)', {
    ...decision,
    decided_at: '2026-10-29T13:00:06.500Z',
  });
  const turn = validCore(handoff.payload);
  assertTurn(turn);
  assert.equal(turn.trigger, 'human_requested');
  assert.equal(turn.asked_field, null);
  assert.equal(turn.latency_ms, 5500);

  // A content handoff (a document) never called the model.
  const content = run(
    'Preparar handoff de conteúdo (MVP)',
    {
      conversation_id: 'conversation-sintetica',
      automation_epoch: 4,
      source_revision: 9,
      contact_context: null,
    },
    {
      'Normalizar evento WhatsApp (MVP)': {
        message_type: 'document',
        channel: 'whatsapp',
        occurred_at: THURSDAY_MORNING,
      },
      'Preparar inbound CRM (MVP)': { received_at: RECEIVED_AT },
    },
  );
  const contentTurn = validCore(content.payload);
  assertTurn(contentTurn);
  assert.equal(contentTurn.model, null);
  assert.equal(contentTurn.trigger, 'unsupported_content');
});

test('telemetry negative: a caller that never timed the turn sends no turn; media kinds are codes', () => {
  const legacy = run('Preparar reserva de envio da IA (MVP)', {
    conversation_id: 'conversation-1',
    automation_epoch: 2,
    source_revision: 7,
    reply_text: 'Qual a cor da camisa?',
    open_order: false,
  });
  assert.equal('turn' in legacy.payload, false);
  assert.equal(validateEvent(legacy.payload, contract), true);

  const sticker = context(
    '[figurinha]',
    {},
    { message_type: 'image', media_kind: '' },
  );
  assert.equal(sticker.turn_media_kind, 'sticker');
  const audio = context(
    '',
    {},
    { message_type: 'audio', media_kind: 'audio', media_source: 'whatsapp' },
    { media_kind: 'audio', media_unreadable: true },
  );
  assert.equal(audio.turn_media_kind, 'audio');
  const document = context('', {}, { message_type: 'document' });
  assert.equal(document.turn_media_kind, null);
});

// 3 — INBOX-AUDIO-TRANSCRIPT-01: the transcript goes back to the CRM.

test('transcript: an audio reports its transcript with a stable key, and either outcome goes on to the reply', () => {
  assert.deepEqual(targets('OpenAI - Transcrever áudio (MVP)'), [
    'Preparar transcrição do áudio (MVP)',
  ]);
  assert.deepEqual(targets('OpenAI - Transcrever áudio (MVP)', 1), [
    'Marcar mídia não lida (MVP)',
  ]);
  assert.deepEqual(targets('Marcar mídia não lida (MVP)'), [
    'Áudio não lido? (MVP)',
  ]);
  assert.deepEqual(targets('Áudio não lido? (MVP)', 0), [
    'Preparar transcrição do áudio (MVP)',
  ]);
  assert.deepEqual(targets('Áudio não lido? (MVP)', 1), [
    'Montar contexto da IA (MVP)',
  ]);
  assert.deepEqual(targets('Preparar transcrição do áudio (MVP)'), [
    'CRM aceita a transcrição? (MVP)',
  ]);
  assert.deepEqual(targets('CRM aceita a transcrição? (MVP)', 0), [
    'CRM - Registrar transcrição do áudio (MVP)',
  ]);
  assert.deepEqual(targets('CRM aceita a transcrição? (MVP)', 1), [
    'Montar contexto da IA (MVP)',
  ]);
  const call = nodes.get('CRM - Registrar transcrição do áudio (MVP)');
  assert.equal(call.onError, 'continueErrorOutput');
  assert.equal(call.retryOnFail, false);
  assert.equal(call.parameters.options.timeout, 5000);
  assert.equal(
    call.parameters.url,
    '={{ $env.SILMER_PANEL_BASE_URL + "/api/v1/integrations/n8n/events" }}',
  );
  assert.deepEqual(targets(call.name, 0), ['Montar contexto da IA (MVP)']);
  assert.deepEqual(targets(call.name, 1), ['Montar contexto da IA (MVP)']);

  const source = {
    event_id: 'wamid.audio-1',
    occurred_at: THURSDAY_MORNING,
    media_kind: 'audio',
  };
  const upstream = {
    'Normalizar evento WhatsApp (MVP)': source,
    'CRM - Reler conversa (MVP)': {
      conversation_id: 'conversation-1',
      contact_context: null,
    },
  };
  const ok = run(
    'Preparar transcrição do áudio (MVP)',
    { text: ' Quero 20 bonés pretos ' },
    upstream,
  );
  assert.deepEqual(ok.payload, {
    schema_version: '1.0',
    event_id: 'transcribed:wamid.audio-1',
    event_type: 'message.transcribed',
    occurred_at: THURSDAY_MORNING,
    conversation_id: 'conversation-1',
    external_message_id: 'wamid.audio-1',
    transcript: { status: 'ok', text: 'Quero 20 bonés pretos' },
  });
  assert.equal(ok.idempotency_key, 'transcribed:wamid.audio-1');
  assert.equal(ok.send_transcript, true);
  // The same key always carries the same payload (no clock in it).
  const again = run(
    'Preparar transcrição do áudio (MVP)',
    { text: ' Quero 20 bonés pretos ' },
    upstream,
  );
  assert.deepEqual(again.payload, ok.payload);
});

test('transcript negative: a failed, empty or too large audio reports the code, never a text', () => {
  const upstream = {
    'Normalizar evento WhatsApp (MVP)': {
      event_id: 'wamid.audio-2',
      occurred_at: THURSDAY_MORNING,
      media_kind: 'audio',
    },
    'CRM - Registrar inbound (MVP)': { conversation_id: 'conversation-2' },
  };
  const prepare = (/** @type {any} */ item) =>
    run('Preparar transcrição do áudio (MVP)', item, upstream).payload
      .transcript;
  assert.deepEqual(prepare({ text: '   ' }), {
    status: 'failed',
    code: 'TRANSCRIPTION_EMPTY',
  });
  const unread = run(
    'Marcar mídia não lida (MVP)',
    { error: 'Request failed with status code 500' },
    upstream,
  );
  assert.equal(unread.failure_code, 'TRANSCRIPTION_FAILED');
  assert.deepEqual(prepare(unread), {
    status: 'failed',
    code: 'TRANSCRIPTION_FAILED',
  });
  const large = run(
    'Marcar mídia não lida (MVP)',
    { error: 'MEDIA_TOO_LARGE' },
    upstream,
  );
  assert.deepEqual(prepare(large), {
    status: 'failed',
    code: 'AUDIO_TOO_LARGE',
  });
});

test('transcript: the context still reads an unread audio after the CRM call, and the history uses the transcript', () => {
  // The CRM answer is the context node's input now; the unread mark is read from its node.
  const unread = context(
    '',
    {},
    { message_type: 'audio', media_kind: 'audio', media_source: 'whatsapp' },
    { accepted: true },
    { 'Marcar mídia não lida (MVP)': { media_unreadable: true } },
  );
  assert.match(unread.prompt, /um áudio que não consegui abrir/u);

  const burst = context(
    'e preciso para dezembro',
    {
      recent_messages: [
        { sender_type: 'ai', text: 'Qual é o seu nome?' },
        {
          sender_type: 'customer',
          type: 'audio',
          text: 'Quero 20 bonés pretos',
          transcribed: true,
          external_id: 'w1',
        },
        {
          sender_type: 'customer',
          type: 'audio',
          text: '',
          external_id: 'w2',
        },
        {
          sender_type: 'customer',
          text: 'e preciso para dezembro',
          external_id: 'w3',
        },
      ],
    },
    { event_id: 'w3' },
  );
  assert.equal(
    burst.current_text,
    '(áudio) Quero 20 bonés pretos.\n(áudio).\ne preciso para dezembro.',
  );
});

// 4 — VND-CTX-01: the subject's history and the returning customer.

/** @param {string} id @param {any} briefing */
function subject(id, briefing) {
  return {
    subject_id: 'subject-' + id,
    kind: 'pedido',
    order_id: 'order-' + id,
    order_number: id + '-CRM',
    order_status: 'pendente',
    briefing,
  };
}

test('context: with two subjects, the history keeps this subject and the untagged messages', () => {
  const shirt = subject('01', { product_type: 'camisetas' });
  const cap = subject('02', { product_type: 'bonés' });
  const ctx = context('A cor será azul', {
    subjects: [shirt, cap],
    source_subject_ids: [shirt.subject_id],
    recent_messages: [
      {
        sender_type: 'customer',
        text: 'Camisetas brancas',
        subject_ids: [shirt.subject_id],
      },
      {
        sender_type: 'customer',
        text: 'Bonés pretos',
        subject_ids: [cap.subject_id],
      },
      { sender_type: 'ai', text: 'Qual a cor da peça?', subject_ids: [] },
    ],
  });
  assert.equal(ctx.target_subject_id, shirt.subject_id);
  assert.deepEqual(
    ctx.recent_messages.map((/** @type {any} */ message) => message.text),
    ['Camisetas brancas', 'Qual a cor da peça?'],
  );
  assert.doesNotMatch(ctx.prompt, /Bonés pretos/u);
});

test('context negative: a CRM without subject_ids still sends no history with two subjects; one subject keeps all', () => {
  const shirt = subject('01', { product_type: 'camisetas' });
  const cap = subject('02', { product_type: 'bonés' });
  const legacy = context('A cor será azul', {
    subjects: [shirt, cap],
    source_subject_ids: [shirt.subject_id],
    recent_messages: [{ sender_type: 'customer', text: 'Histórico misturado' }],
  });
  assert.deepEqual(legacy.recent_messages, []);

  const single = context('A cor será azul', {
    subjects: [shirt],
    recent_messages: [
      { sender_type: 'customer', text: 'Oi', subject_ids: ['subject-99'] },
    ],
  });
  assert.equal(single.recent_messages.length, 1);
});

test('context: a returning customer is only that fact, with no number, product or date', () => {
  for (const contact_context of [
    {
      previous_cycles: 2,
      previous_orders_count: 1,
      last_closed_at: '2026-08-14',
    },
    { previous_cycles: 0, previous_orders_count: 3, last_closed_at: null },
  ]) {
    const ctx = context('Oi, quero fazer camisetas', { contact_context });
    assert.equal(ctx.returning_customer, true);
    const line = ctx.prompt
      .split('\n')
      .find((/** @type {string} */ entry) =>
        entry.startsWith('Cliente recorrente'),
      );
    assert.equal(
      line,
      'Cliente recorrente: já foi atendido pela Silmer antes. Pode dizer que é bom falar com a pessoa de novo. Trate esta conversa como um pedido novo: não suponha que é o mesmo pedido, não fale de pedido anterior se o cliente não citar e nunca cite valores.',
    );
    assert.doesNotMatch(
      ctx.prompt,
      /2026-08|08\/2026|\b[123] (atendimento|pedido)/u,
    );
  }
  const prompt = nodes.get('Atendente virtual Silmer (MVP)').parameters.options
    .systemMessage;
  assert.match(prompt, /CLIENTE RECORRENTE/u);
  // The context node no longer reads the fields of the first draft.
  const code = nodes.get('Montar contexto da IA (MVP)').parameters.jsCode;
  assert.doesNotMatch(
    code,
    /previous_orders\b|created_month|order_number\)\.trim/u,
  );

  // The workflow's own greeting (an image turn) welcomes back, nothing more.
  const image = decide(
    context(
      '',
      {
        contact_context: {
          previous_cycles: 1,
          previous_orders_count: 0,
          last_closed_at: '2026-08-14',
        },
      },
      { message_type: 'image', media_kind: 'image', media_source: 'whatsapp' },
      { media_kind: 'image', media_unreadable: true },
    ),
    { answer_status: 'none' },
  );
  assert.match(
    image.reply_text,
    /^Oi! Que bom falar com você de novo\. Sou a assistente virtual da Silmer\./u,
  );
  assert.doesNotMatch(image.reply_text, /pedido anterior|2026/u);
});

test('context negative: without contact_context, a first contact or the old list, nothing changes', () => {
  for (const inbound of [
    {},
    { contact_context: null },
    {
      contact_context: {
        previous_cycles: 0,
        previous_orders_count: 0,
        last_closed_at: null,
      },
    },
    // The first draft's list is ignored: only the counts say "returning".
    {
      contact_context: {
        previous_cycles: 0,
        previous_orders_count: 0,
        previous_orders: [
          { order_number: '03-CRM', product_type: 'camisetas' },
        ],
      },
    },
  ]) {
    const ctx = context('Oi', inbound);
    assert.equal(ctx.returning_customer, false);
    assert.doesNotMatch(ctx.prompt, /Cliente recorrente|03-CRM/u);
  }
  const image = decide(
    context(
      '',
      {},
      { message_type: 'image', media_kind: 'image', media_source: 'whatsapp' },
      { media_kind: 'image', media_unreadable: true },
    ),
  );
  assert.match(image.reply_text, /^Oi! Sou a assistente virtual da Silmer\./u);
});

// 5 — INBOX-HANDOFF-02: the seller asked by name and the partnership reason.

test('handoff: a seller asked by name goes with the id the CRM listed', () => {
  const decision = decide(context('Quero falar com a Bianca'), {
    person_request: 'named',
    requested_person_name: 'Bianca',
    requested_seller: 'Bianca',
  });
  assert.equal(decision.trigger, 'seller_requested');
  assert.equal(decision.requested_seller_id, SELLER_ID);
  const handoff = run('Preparar handoff da IA (MVP)', decision).payload;
  assert.equal(handoff.handoff.requested_seller_id, SELLER_ID);
  assert.equal(handoff.handoff.reason, 'human_requested');
  validCore(handoff);
});

test('handoff negative: a name outside the list, a shared first name or a generic request names no seller', () => {
  const unknown = decide(context('Quero falar com a Carla'), {
    person_request: 'named',
    requested_person_name: 'Carla',
    requested_seller: null,
  });
  assert.equal(unknown.requested_seller_id, null);

  const twins = decide(
    context('Quero falar com a Bianca', {
      sellers: [
        { id: SELLER_ID, name: 'Bianca' },
        { id: OTHER_SELLER_ID, name: 'Bianca' },
      ],
    }),
    {
      person_request: 'named',
      requested_person_name: 'Bianca',
      requested_seller: 'Bianca',
    },
  );
  assert.equal(twins.trigger, 'seller_requested');
  assert.equal(twins.requested_seller_id, null);
  const payload = run('Preparar handoff da IA (MVP)', twins).payload;
  assert.equal('requested_seller_id' in payload.handoff, false);

  const generic = decide(context('Quero falar com um atendente'), {
    person_request: 'generic',
  });
  assert.equal(generic.requested_seller_id, null);

  // An id out of shape (spaces, too long) is never forwarded.
  for (const id of ['user 1', 'x'.repeat(129), '']) {
    const odd = decide(
      context('Quero falar com a Bianca', {
        sellers: [{ id, name: 'Bianca' }],
      }),
      {
        person_request: 'named',
        requested_person_name: 'Bianca',
        requested_seller: 'Bianca',
      },
    );
    assert.equal(odd.requested_seller_id, null, id);
  }
});

test('handoff: partnership, resale, wholesale and invoice use the partnership reason', () => {
  for (const text of [
    'Vocês fazem parceria?',
    'Quero revender as camisetas',
    'Tem preço de atacado?',
    'Vocês emitem nota fiscal?',
  ]) {
    const result = decide(context(text));
    assert.equal(result.trigger, 'partnership', text);
    assert.equal(result.handoff_reason, 'partnership', text);
  }
});

test('handoff negative: "loja" alone, or photos the customer sends, are not a partnership', () => {
  for (const text of [
    'Tenho uma loja e quero 30 camisetas',
    'Sou da Loja Sintética, quero bonés',
    'É para a loja',
    'Vou mandar fotos das peças que eu quero',
    'Segue as fotos das peças de referência',
  ]) {
    const result = decide(context(text));
    assert.notEqual(result.trigger, 'partnership', text);
    assert.notEqual(result.handoff_reason, 'partnership', text);
  }
  assert.equal(
    decide(context('Vocês têm fotos das peças que já fizeram?')).trigger,
    'partnership',
  );
});

// 5b — QA M3: the new fields go only to a CRM that announces them.

/** A CRM answer without contact_context: the CRM of mvp-simple-19. */
const LEGACY = { contact_context: undefined };

test('capability: the CRM of this round gets turn, seller id, the new reasons and the transcript', () => {
  const ctx = context('Quero falar com a Bianca');
  assert.equal(ctx.crm_evolution, true);
  const seller = run(
    'Preparar handoff da IA (MVP)',
    decide(ctx, {
      person_request: 'named',
      requested_person_name: 'Bianca',
      requested_seller: 'Bianca',
    }),
  ).payload;
  assert.equal(seller.handoff.requested_seller_id, SELLER_ID);
  assertTurn(seller.turn);
  assert.equal(
    decide(context('Vocês fazem parceria?')).handoff_reason,
    'partnership',
  );
  const failure = run(
    'Preparar handoff de falha da IA (MVP)',
    {},
    { 'Montar contexto da IA (MVP)': ctx },
  ).payload;
  assert.equal(failure.handoff.reason, 'automation_failure');
  assertTurn(failure.turn);
});

test('capability negative: against an older CRM the workflow sends only what it already accepts', () => {
  const ctx = context('Quero falar com a Bianca', LEGACY);
  assert.equal(ctx.crm_evolution, false);
  assert.equal('turn_started_at' in ctx, true);

  // The seller is named in the summary only; no turn, no seller id.
  const seller = run(
    'Preparar handoff da IA (MVP)',
    decide(ctx, {
      person_request: 'named',
      requested_person_name: 'Bianca',
      requested_seller: 'Bianca',
    }),
  ).payload;
  assert.equal(seller.handoff.reason, 'human_requested');
  assert.equal('requested_seller_id' in seller.handoff, false);
  assert.equal('turn' in seller, false);
  assert.match(seller.handoff.summary, /Vendedor pedido: Bianca\./u);
  assert.equal(validateEvent(seller, contract), true);

  // A plain reply: no turn.
  const reply = run(
    'Preparar reserva de envio da IA (MVP)',
    decide(context('Branca', { ...LEGACY, briefing: shirtWithout('colors') }), {
      answer_status: 'answered',
      briefing_patch: { colors: 'branca' },
      reply_text: 'Quantas peças você precisa?',
      asked_field: 'quantity',
    }),
  ).payload;
  assert.equal('turn' in reply, false);
  assert.equal(validateEvent(reply, contract), true);

  // Partnership falls back to human_requested, a failure to unsupported.
  assert.equal(
    decide(context('Vocês fazem parceria?', LEGACY)).handoff_reason,
    'human_requested',
  );
  const failure = run(
    'Preparar handoff de falha da IA (MVP)',
    {},
    { 'Montar contexto da IA (MVP)': ctx },
  ).payload;
  assert.equal(failure.handoff.reason, 'unsupported');
  assert.equal('turn' in failure, false);
  assert.equal(failure.handoff.notice.text.length > 0, true);
  assert.equal(validateEvent(failure, contract), true);

  // A content handoff: no turn.
  const content = run(
    'Preparar handoff de conteúdo (MVP)',
    {
      conversation_id: 'conversation-sintetica',
      automation_epoch: 4,
      source_revision: 9,
    },
    {
      'Normalizar evento WhatsApp (MVP)': {
        message_type: 'document',
        channel: 'whatsapp',
        occurred_at: THURSDAY_MORNING,
      },
      'Preparar inbound CRM (MVP)': { received_at: RECEIVED_AT },
    },
  ).payload;
  assert.equal('turn' in content, false);
  assert.equal(validateEvent(content, contract), true);

  // The transcript is not sent; the turn goes straight on to the context.
  const transcript = run(
    'Preparar transcrição do áudio (MVP)',
    { text: 'Quero 20 bonés pretos' },
    {
      'Normalizar evento WhatsApp (MVP)': {
        event_id: 'wamid.audio-legacy',
        occurred_at: THURSDAY_MORNING,
        media_kind: 'audio',
      },
      'CRM - Reler conversa (MVP)': { conversation_id: 'conversation-1' },
    },
  );
  assert.equal(transcript.send_transcript, false);
  const gate = nodes.get('CRM aceita a transcrição? (MVP)').parameters
    .conditions.conditions[0].leftValue;
  assert.match(gate, /\$json\.send_transcript === true/u);
});

// 6 — False positives of ADRs 049 and 051.

test('false positive: the own e-mail, phone or a reference link is an order from scratch', () => {
  for (const text of [
    'Meu e-mail é rafa@exemplo.invalid',
    'Meu telefone é 27 90000-0000, pode anotar',
    'Pode anotar meu número e meu contato',
    'Meu celular é esse mesmo',
    'Segue o link de referência: https://exemplo.invalid/camisa, quero algo parecido',
    'https://exemplo.invalid/foto essa é a referência',
    // VND-L03 (QA M4): how the customer found the Silmer, or their own device.
    'Passei pelo instagram de vocês e quero 30 camisetas',
    'passei o olho no insta de vocês e gostei',
    'Respondo pelo celular depois',
    'Vi vocês no direct de uma amiga',
    'Gostei do atendimento pelo instagram de vocês',
    'Quero o mesmo modelo para todos',
    'Quero igual da foto',
    'Vou repetir a estampa nas costas',
    'No ano passado vi vocês num evento',
  ]) {
    const result = decide(context(text, { briefing: shirtWithout('colors') }), {
      external_context: false,
    });
    assert.notEqual(result.trigger, 'external_context', text);
    assert.equal(result.handoff_required, false, text);
  }
});

test('false positive negative: asking to move channel or citing an order elsewhere still calls a seller', () => {
  for (const text of [
    'Me manda o orçamento por e-mail',
    'Pode me enviar por e-mail?',
    'Me liga, por favor',
    'Pode me ligar amanhã?',
    'Qual o seu número?',
    'Prefiro falar por telefone',
    'Me passa o contato do vendedor',
    'Já falei com a moça da loja',
    'Quero igual ao pedido anterior',
    // VND-L03 (QA M4): a repeated order is not from scratch.
    'Quero repetir o pedido',
    'Quero igual da última vez',
    'Quero o mesmo do ano passado',
    // A request to answer elsewhere still counts.
    'Me passa os valores por e-mail',
    'Me responde pelo whatsapp do vendedor',
    'Prefiro falar pelo direct',
    'https://exemplo.invalid/p/abc quero essa',
  ]) {
    const result = decide(context(text, { briefing: shirtWithout('colors') }), {
      external_context: false,
    });
    assert.equal(result.trigger, 'external_context', text);
    assert.equal(result.handoff_reason, 'human_requested', text);
  }
});

test('false positive: a bare "Sim" records the art only right after the art question', () => {
  const pending = {
    ...shirtWithout('artwork_status', 'needed_by'),
    next_required_field: 'artwork_status',
  };
  const asked = decide(
    context('Sim', {
      briefing: pending,
      recent_messages: [{ sender_type: 'ai', text: ART_QUESTION }],
    }),
    { answer_status: 'answered', reply_text: 'Para quando você precisa?' },
  );
  assert.equal(asked.briefing_patch.artwork_status, 'cliente envia a arte');

  // Another question was the last one (or no reply is known): no art recorded.
  for (const history of [
    [{ sender_type: 'ai', text: 'Onde vai a estampa: só na frente?' }],
    [],
  ]) {
    const result = decide(
      context('Sim', { briefing: pending, recent_messages: history }),
      {
        answer_status: 'answered',
        briefing_patch: { artwork_status: 'cliente envia a arte' },
      },
    );
    assert.equal(result.briefing_patch.artwork_status, undefined);
    assert.equal(result.briefing_patch.next_required_field, 'artwork_status');
  }
  // A full answer is still read without the question in the history.
  const full = decide(
    context('Já tenho a logo pronta', { briefing: pending }),
    {
      answer_status: 'answered',
    },
  );
  assert.equal(full.briefing_patch.artwork_status, 'cliente envia a arte');
});

test('false positive: "faixa etária" or "na faixa de" is not a flag; a "faixa" of a size still is', () => {
  const ages = context('ok', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'camisetas para a faixa etária infantil',
    },
  });
  assert.match(ages.prompt, /Produto: roupa\n/u);
  const range = context('ok', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'camisetas na faixa de 50 peças',
    },
  });
  assert.match(range.prompt, /Produto: roupa\n/u);
  const flag = context('ok', {
    briefing: { customer_name: 'Rafa', product_type: 'faixa de 3 x 1 m' },
  });
  assert.match(flag.prompt, /Produto: bandeira, faixa ou banner\n/u);
});

test('false positive: "jogo" alone is not a clothing model; "de time" and "camisa de jogo" are', () => {
  const pending = {
    customer_name: 'Rafa',
    product_type: 'camisetas',
    next_required_field: 'product_model',
    briefing_status: 'collecting',
  };
  for (const text of ['um jogo', 'jogo completo']) {
    const result = decide(context(text, { briefing: pending }), {
      answer_status: 'unclear',
    });
    assert.equal(result.briefing_patch?.product_model, undefined, text);
  }
  for (const [text, model] of [
    ['de time', 'camisa de time'],
    ['camisa de jogo', 'camisa de jogo'],
  ]) {
    const result = decide(context(text, { briefing: pending }), {
      answer_status: 'answered',
    });
    assert.equal(result.briefing_patch.product_model, model, text);
  }
});

// 7 — Tone.

test('tone: the price notice no longer opens with "Ótima pergunta!"', () => {
  const result = decide(
    context('E aí, quanto fica?', {
      briefing: {
        ...shirtWithout('colors'),
        briefing_status: 'quote_price_collecting',
      },
    }),
    { asks_price: true },
  );
  assert.equal(result.trigger, 'price');
  assert.equal(
    result.reply_text,
    'Os valores são passados pelos nossos vendedores, que montam o orçamento certinho para você. Um deles vai continuar o seu atendimento aqui mesmo.',
  );
  assert.doesNotMatch(sdk, /'Ótima pergunta!/u);
});

// 8 — National holidays (2026-2027).

/** @param {string} occurred_at */
function transferNotice(occurred_at) {
  return decide(context('Quero falar com um atendente', {}, { occurred_at }), {
    person_request: 'generic',
  }).reply_text;
}

test('holidays: a holiday is closed, and the next opening skips it', () => {
  // Friday 20/11/2026 (Consciência Negra), 10:00.
  assert.match(
    transferNotice('2026-11-20T13:00:00.000Z'),
    /Hoje é feriado e não temos atendimento\. Um vendedor te responde a partir de amanhã às 9h\.$/u,
  );
  // Thursday 19/11/2026 19:00: Friday is a holiday, so Saturday.
  assert.match(
    transferNotice('2026-11-19T22:00:00.000Z'),
    /exceto feriados\. Um vendedor te responde a partir de sábado às 9h\.$/u,
  );
  // Saturday 31/10/2026 13:00: Monday 02/11 is Finados, so Tuesday.
  assert.match(
    transferNotice('2026-10-31T16:00:00.000Z'),
    /a partir de terça-feira às 9h\.$/u,
  );
  // Saturday 06/02/2027 13:00: Carnival Monday and Tuesday, so Wednesday.
  assert.match(
    transferNotice('2027-02-06T16:00:00.000Z'),
    /a partir de quarta-feira às 9h\.$/u,
  );
  // Thursday 02/04/2026 19:00: Good Friday, so Saturday.
  assert.match(
    transferNotice('2026-04-02T22:00:00.000Z'),
    /a partir de sábado às 9h\.$/u,
  );
  // Wednesday 26/05/2027 17:45 (closing): Corpus Christi, so Friday.
  assert.match(
    transferNotice('2027-05-26T20:45:00.000Z'),
    /exceto feriados e está perto de acabar\. Se não der tempo hoje, um vendedor te responde a partir de sexta-feira às 9h\.$/u,
  );
  // Thursday 04/06/2026 (Corpus Christi), 10:00.
  assert.match(transferNotice('2026-06-04T13:00:00.000Z'), /Hoje é feriado/u);
});

test('holidays negative: a working day keeps the plain notice, and a Sunday holiday changes nothing', () => {
  // Wednesday 25/11/2026 10:00: inside the hours, no line.
  assert.equal(
    transferNotice('2026-11-25T13:00:00.000Z'),
    'Claro! Um dos nossos vendedores vai continuar o seu atendimento aqui mesmo.',
  );
  // Wednesday 25/11/2026 19:00: tomorrow, no holiday words.
  const evening = transferNotice('2026-11-25T22:00:00.000Z');
  assert.match(evening, /a partir de amanhã às 9h\.$/u);
  assert.doesNotMatch(evening, /feriado/u);
  // Sunday 15/11/2026 (Proclamação da República) is closed anyway.
  const sunday = transferNotice('2026-11-15T13:00:00.000Z');
  assert.doesNotMatch(sunday, /feriado/u);
  assert.match(sunday, /a partir de amanhã às 9h\.$/u);
});

// 9 — The version and what stays intact.

test('version: mvp-simple-22 on every CRM call, still under the subject-v1 contract', () => {
  const version = /const WORKFLOW_VERSION = '(mvp-simple-(\d+))';/u.exec(sdk);
  assert.ok(version);
  assert.equal(version[1], 'mvp-simple-22');
  // requiresSubjectContract (modules/n8n-integration/src/service.js): >= 15.
  assert.ok(Number(version[2]) >= 15);
  const headers = snapshot.nodes
    .flatMap(
      (/** @type {any} */ node) =>
        node.parameters?.headerParameters?.parameters ?? [],
    )
    .filter(
      (/** @type {any} */ header) =>
        header.name === 'X-Silmer-Workflow-Version',
    );
  assert.ok(headers.length > 10);
  for (const header of headers) assert.equal(header.value, 'mvp-simple-22');
});

test('intact: the guardrail and the fence stay as published', () => {
  for (const name of [
    'Montar contexto da IA (MVP)',
    'Normalizar decisão da IA (MVP)',
  ]) {
    const code = nodes.get(name).parameters.jsCode;
    assert.match(code, /function silmerGuardrail/u, name);
    assert.match(code, /silmer-guardrail-1/u, name);
  }
  const reservation = run(
    'Preparar reserva de envio da IA (MVP)',
    decide(context('Branca', { briefing: shirtWithout('colors') }), {
      answer_status: 'answered',
      briefing_patch: { colors: 'branca' },
      reply_text: 'Quantas peças você precisa?',
      asked_field: 'quantity',
    }),
  ).payload;
  assert.equal(reservation.automation_epoch, 4);
  assert.equal(reservation.source_revision, 9);
  assert.equal(reservation.command_id, 'conversation-sintetica:9:ai-response');
});
