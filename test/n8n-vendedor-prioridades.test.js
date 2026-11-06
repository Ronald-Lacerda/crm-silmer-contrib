import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// VND-L05 / AGT-01..05, AGT-08: exercise the actual generated Code nodes.
// All conversations are synthetic. Extraction is supplied explicitly; these
// assertions verify workflow guardrails, not a provider's language accuracy.
const snapshot = JSON.parse(
  await readFile(
    new URL(
      '../ops/n8n/workflows/k7tI6T4RhQPyJkn9-mvp-simple.sanitized.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const nodes = new Map(
  snapshot.nodes.map((/** @type {any} */ node) => [node.name, node]),
);
const MESSAGE_AT = '2026-11-06T13:00:00.000Z';

/** @param {string} name @param {any} item @param {Record<string, any>} upstream */
function run(name, item, upstream) {
  const result = vm.runInNewContext(
    `(() => {\n${nodes.get(name).parameters.jsCode}\n})()`,
    {
      $json: item,
      $input: { item: { json: item } },
      $: (/** @type {string} */ key) => {
        if (!(key in upstream)) throw new Error(`Missing upstream ${key}`);
        return { item: { json: upstream[key] } };
      },
      $execution: { id: 'synthetic-vnd-l05' },
    },
  );
  return JSON.parse(JSON.stringify(result.json));
}

/** @param {string} text @param {any} [inbound] */
function context(text, inbound = {}) {
  const crm = {
    accepted: true,
    conversation_id: 'conversation-synthetic-l05',
    automation_epoch: 7,
    source_revision: 12,
    automation_message_count: 2,
    automation_message_cap: 15,
    order_opening_policy: 'human_confirmation',
    briefing: {},
    recent_messages: [],
    subjects: [],
    source_subject_ids: [],
    sellers: [],
    ...inbound,
  };
  return run('Montar contexto da IA (MVP)', crm, {
    'CRM - Registrar inbound (MVP)': crm,
    'Normalizar evento WhatsApp (MVP)': {
      channel: 'whatsapp',
      event_id: 'synthetic-event-l05',
      from: '5500000000042',
      phone_number_id: 'synthetic-line',
      text,
      customer_name: '',
      message_type: 'text',
      occurred_at: MESSAGE_AT,
    },
  });
}

/** @param {any} ctx @param {any} [output] */
function decide(ctx, output = {}) {
  return run(
    'Normalizar decisão da IA (MVP)',
    {
      output: {
        reply_text: 'Qual cor você quer?',
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

for (const text of [
  'Qual o mínimo para polo?',
  'Qual a quantidade mínima?',
  'Tem pedido mínimo?',
  'A partir de quantas peças vocês produzem?',
  'Precisa de no mínimo quantas peças?',
]) {
  test(`minimum question transfers without inventing a commercial rule: ${text}`, () => {
    const result = decide(context(text), {
      reply_text: 'Para eu registrar seu teste, seria 1, 2 ou algumas polos?',
      answer_status: 'question',
    });
    assert.equal(result.trigger, 'commercial_question');
    assert.equal(result.handoff_reason, 'human_requested');
    assert.equal(result.handoff_required, true);
    assert.equal(result.open_order, false);
    assert.equal(result.asked_point, null);
    assert.match(result.reasoning, /mínim|minim|quantas/iu);
    assert.doesNotMatch(
      result.reply_text,
      /\b(?:1|2|10|dez|duas|duas?)\b|quantas|qual cor/iu,
    );
  });
}

for (const text of [
  'Vocês fazem camisetas oversized?',
  'Conseguem fazer igual à referência?',
  'Vocês trabalham com estampa na minha peça?',
]) {
  test(`production capability is a seller decision: ${text}`, () => {
    const result = decide(context(text), {
      reply_text: 'Sim, fazemos esse modelo. Qual cor você quer?',
      answer_status: 'question',
    });
    assert.equal(result.trigger, 'commercial_question');
    assert.equal(result.handoff_reason, 'human_requested');
    assert.match(result.reasoning, /Perguntas|Dúvida|confirmar/iu);
    assert.doesNotMatch(
      result.reply_text,
      /sim, fazemos|não fazemos|qual cor/iu,
    );
  });
}

test('a capability question wins over the first price deferral and keeps volunteered facts', () => {
  const result = decide(
    context('Vocês conseguem produzir duas polos azuis? Quanto fica?'),
    {
      asks_price: true,
      answer_status: 'question',
      briefing_patch: {
        product_type: 'camisetas',
        product_model: 'polo',
        quantity: 2,
        colors: 'azul',
      },
    },
  );
  assert.equal(result.trigger, 'commercial_question');
  assert.equal(result.briefing_patch.quantity, 2);
  assert.equal(result.briefing_patch.colors, 'azul');
  assert.equal(result.open_order, false);
  assert.match(result.reasoning, /produzir duas polos azuis/iu);
  assert.doesNotMatch(
    result.reply_text,
    /me conta|mínimo de 10|mínimo de dez/iu,
  );
});

test('an ordinary quote or a product name alone does not imply a commercial blocker', () => {
  for (const text of [
    'Vocês fazem orçamento?',
    'Quero um orçamento de camisetas',
    'Quero 10 polos azuis',
    'Quero uma camiseta oversized',
  ]) {
    const result = decide(context(text), {
      briefing_patch: { product_type: 'camisetas' },
    });
    assert.equal(result.handoff_required, false, text);
    assert.notEqual(result.trigger, 'commercial_question', text);
  }
});

test('minimum detail wording and a customer quantity floor are not production minimum questions', () => {
  for (const text of [
    'Com o mínimo de detalhes: quero polos azuis',
    'Quero no mínimo 12 camisetas',
    'Use o mínimo de informações, quero camisetas',
  ]) {
    const result = decide(context(text), {
      briefing_patch: { product_type: 'camisetas' },
    });
    assert.notEqual(result.trigger, 'commercial_question', text);
    assert.equal(result.handoff_required, false, text);
  }
});

test('an explicit art creation request preserves its existing deferred commercial confirmation', () => {
  const result = decide(
    context('Vocês podem criar a arte?', {
      briefing: {
        product_type: 'camisetas',
        next_required_field: 'artwork_status',
      },
    }),
    { briefing_patch: { artwork_status: 'Silmer cria a arte' } },
  );
  assert.notEqual(result.trigger, 'commercial_question');
  assert.equal(result.briefing_patch.artwork_status, 'Silmer cria a arte');
  assert.equal(result.open_order, false);
});

for (const text of [
  'Preciso das camisetas para hoje',
  'Preciso de duas camisetas para amanhã',
  'A entrega das camisas precisa ser amanhã',
]) {
  test(`a clear urgent delivery transfers before collecting the rest: ${text}`, () => {
    const result = decide(context(text), {
      briefing_patch: { product_type: 'camisetas' },
    });
    assert.equal(result.trigger, 'deadline_urgency');
    assert.equal(result.handoff_reason, 'urgency');
    assert.equal(result.handoff_required, true);
    assert.equal(result.handoff_ready, false);
    assert.equal(result.asked_point, null);
    assert.ok(result.missing_briefing_fields.includes('artwork_status'));
    assert.match(result.reasoning, /Faltam:/u);
    assert.doesNotMatch(
      result.reply_text,
      /agora|imediatamente|garantid|qual.*arte/iu,
    );
    assert.equal(result.open_order, false);
  });
}

test('the urgent day belongs to the delivery clause rather than an artwork date', () => {
  for (const text of [
    'Preciso receber hoje; amanhã envio a arte',
    'Preciso retirar hoje, a arte fica para depois de amanhã',
    'Preciso das camisetas para hoje. Amanhã mando a arte',
    'Não preciso pagar amanhã, preciso receber hoje',
  ]) {
    const result = decide(context(text), {
      briefing_patch: { product_type: 'camisetas' },
    });
    assert.equal(result.trigger, 'deadline_urgency', text);
    assert.equal(result.handoff_reason, 'urgency', text);
    assert.match(result.briefing_patch.needed_by, /06\/11\/2026/u, text);
    assert.doesNotMatch(result.briefing_patch.needed_by, /07\/11\/2026/u, text);
    assert.equal(result.open_order, false, text);
  }
});

test('a supplied urgent deadline remains urgent with missing art and fabric', () => {
  const result = decide(
    context('Para amanhã', {
      briefing: {
        product_type: 'camisetas',
        quantity: 3,
        next_required_field: 'needed_by',
      },
    }),
    { briefing_patch: { needed_by: 'amanhã' }, answer_status: 'answered' },
  );
  assert.equal(result.handoff_reason, 'urgency');
  assert.match(result.briefing_patch.needed_by, /07\/11\/2026/u);
  assert.ok(result.missing_briefing_fields.includes('artwork_status'));
});

test('art transmission, payment, and future dates are not an urgent product deadline', () => {
  for (const text of [
    'Amanhã envio a arte',
    'Preciso enviar a arte hoje',
    'Posso pagar hoje?',
    'Preciso do orçamento para amanhã',
    'Não preciso das camisetas para amanhã',
    'Preciso das camisetas para o próximo mês',
  ]) {
    const result = decide(context(text), {
      briefing_patch: { product_type: 'camisetas' },
    });
    assert.notEqual(result.handoff_reason, 'urgency', text);
    assert.equal(result.briefing_patch.needed_by, undefined, text);
  }
});

test('a distant explicit deadline does not transfer an incomplete ficha', () => {
  const result = decide(context('Preciso para 20/11'), {
    briefing_patch: { product_type: 'camisetas', needed_by: '20/11' },
  });
  assert.equal(result.handoff_required, false);
  assert.equal(result.briefing_patch.needed_by, '20/11');
});

for (const [text, quantities] of /** @type {[string, number[]][]} */ ([
  ['Faça orçamento para 10 e 20 unidades', [10, 20]],
  ['Qual o valor de 1 e de 2 peças?', [1, 2]],
])) {
  test(`alternative quotes never choose or add the quantity: ${text}`, () => {
    for (const extracted of [
      quantities[0],
      quantities[1],
      quantities[0] + quantities[1],
    ]) {
      const result = decide(context(text), {
        asks_price: true,
        briefing_patch: { product_type: 'camisetas', quantity: extracted },
      });
      assert.equal(result.trigger, 'commercial_question');
      assert.equal(result.briefing_patch.quantity, undefined);
      assert.match(
        result.briefing_patch.notes,
        new RegExp(String(quantities[0]), 'u'),
      );
      assert.match(
        result.briefing_patch.notes,
        new RegExp(String(quantities[1]), 'u'),
      );
      assert.equal(result.open_order, false);
    }
  });
}

test('alternative quantities keep a previously confirmed quantity unchanged', () => {
  const result = decide(
    context('Pode orçar 10 e 20 unidades?', {
      briefing: { product_type: 'camisetas', quantity: 8 },
    }),
    { briefing_patch: { quantity: 20 } },
  );
  assert.equal(result.trigger, 'commercial_question');
  assert.equal(result.briefing_patch.quantity, undefined);
  assert.match(result.briefing_patch.notes, /10.*20/u);
});

test('a confirmed distribution and a later correction remain ordinary quantities', () => {
  const distributed = decide(context('Quero 10 M e 20 G'), {
    briefing_patch: {
      product_type: 'camisetas',
      quantity: 30,
      sizes: '10 M e 20 G',
    },
  });
  assert.notEqual(distributed.trigger, 'commercial_question');
  assert.equal(distributed.briefing_patch.quantity, 30);
  const corrected = decide(
    context('Na verdade, serão 20 peças', {
      briefing: { product_type: 'camisetas', quantity: 10 },
    }),
    { briefing_patch: { quantity: 20 }, answer_status: 'answered' },
  );
  assert.notEqual(corrected.trigger, 'commercial_question');
  assert.equal(corrected.briefing_patch.quantity, 20);
});

test('answered fields supplied out of order survive and are not asked again', () => {
  const result = decide(
    context('Sou Cliente Sintético. Quero 12 polos azuis em dry fit'),
    {
      briefing_patch: {
        customer_name: 'Cliente Sintético',
        product_type: 'camisetas',
        product_model: 'polo',
        colors: 'azul',
        quantity: 12,
        fabrics: 'dry fit',
      },
      asked_field: 'colors',
      reply_text: 'Qual cor você quer?',
      answer_status: 'answered',
    },
  );
  assert.equal(result.briefing_patch.product_model, 'polo');
  assert.equal(result.briefing_patch.colors, 'azul');
  assert.equal(result.briefing_patch.quantity, 12);
  assert.equal(result.briefing_patch.fabrics, 'dry fit');
  assert.doesNotMatch(
    result.reply_text,
    /qual cor|qual tecido|quantas peças/iu,
  );
});

test('a valid asked_field cannot conceal a question about an already answered color', () => {
  const result = decide(
    context('Azul', {
      briefing: {
        customer_name: 'Cliente Sintético',
        product_type: 'camisetas',
        product_model: 'camiseta comum',
        next_required_field: 'colors',
      },
    }),
    {
      briefing_patch: { colors: 'azul' },
      asked_field: 'quantity',
      reply_text: 'Qual cor você quer?',
      answer_status: 'answered',
    },
  );
  assert.equal(result.briefing_patch.colors, 'azul');
  assert.equal(result.asked_point, 'quantity');
  assert.match(result.reply_text, /Quantas peças você precisa\?/u);
  assert.doesNotMatch(result.reply_text, /qual cor/iu);
});

test('a size distribution in a quote request is not an alternative quantity', () => {
  const result = decide(context('Qual o preço para 10 M e 20 G?'), {
    briefing_patch: {
      product_type: 'camisetas',
      quantity: 30,
      sizes: '10 M e 20 G',
    },
  });
  assert.notEqual(result.trigger, 'commercial_question');
  assert.equal(result.briefing_patch.quantity, 30);
});

test('withdrawal, excluded products and an ambiguous target still suppress official projection', () => {
  for (const text of [
    'Desisti do pedido. Qual o mínimo?',
    'Qual o mínimo para bolsas?',
    'Quero dois pedidos separados. Qual o mínimo?',
  ]) {
    const result = decide(context(text), {
      briefing_patch: { product_type: 'camisetas', quantity: 10 },
    });
    assert.equal(result.handoff_required, true, text);
    assert.notEqual(result.trigger, 'commercial_question', text);
    assert.equal(result.briefing_patch, null, text);
    assert.equal(result.open_order, false, text);
  }
});

test('a requested person or a complaint retains precedence over commercial clarification', () => {
  const person = decide(context('Quero falar com uma pessoa. Qual o mínimo?'), {
    person_request: 'generic',
  });
  assert.equal(person.trigger, 'human_requested');
  const complaint = decide(
    context('Estou insatisfeito com a demora. Qual o mínimo?'),
    {
      handoff_required: true,
      handoff_reason: 'complaint',
    },
  );
  assert.equal(complaint.trigger, 'complaint');
});

test('missing artwork does not negate a desired delivery tomorrow', () => {
  const result = decide(context('Não tenho arte, preciso para amanhã'), {
    briefing_patch: { product_type: 'camisetas' },
  });
  assert.equal(result.trigger, 'deadline_urgency');
  assert.equal(result.handoff_reason, 'urgency');
  assert.match(result.briefing_patch.needed_by, /07\/11\/2026/u);
});

test('alternative delivery dates are confirmed without choosing one', () => {
  const result = decide(context('Preciso de camisas para hoje ou amanhã'), {
    briefing_patch: { product_type: 'camisetas', needed_by: 'amanhã' },
  });
  assert.equal(result.handoff_required, false);
  assert.equal(result.briefing_patch.needed_by, 'hoje ou amanhã (a confirmar)');
  assert.match(result.reply_text, /hoje ou para amanhã\?/u);
  const unclear = decide(
    context('Sim', {
      briefing: {
        product_type: 'camisetas',
        needed_by: 'hoje ou amanhã (a confirmar)',
        next_required_field: 'needed_by',
      },
    }),
    { briefing_patch: { needed_by: 'amanhã' } },
  );
  assert.equal(unclear.handoff_required, true);
  assert.equal(unclear.handoff_reason, 'human_requested');
  assert.match(
    unclear.reasoning,
    /Prazo desejado continua entre hoje e amanhã/u,
  );
  assert.equal(
    unclear.briefing_patch.needed_by,
    'hoje ou amanhã (a confirmar)',
  );
});

test('repeating an ambiguous delivery after its confirmation transfers once', () => {
  const repeated = decide(
    context('Preciso hoje ou amanhã', {
      briefing: {
        product_type: 'camisetas',
        needed_by: 'hoje ou amanhã (a confirmar)',
        next_required_field: 'needed_by',
      },
    }),
  );
  assert.equal(repeated.handoff_reason, 'human_requested');
  assert.equal(
    repeated.briefing_patch.needed_by,
    'hoje ou amanhã (a confirmar)',
  );
});

test('a commercial handoff preserves epoch and revision and never creates an order', () => {
  const decision = decide(context('Qual o mínimo para produzir?'));
  const result = run('Preparar handoff da IA (MVP)', decision, {});
  assert.equal(decision.automation_epoch, 7);
  assert.equal(decision.source_revision, 12);
  assert.equal(decision.open_order, false);
  assert.equal(result.payload.handoff.reason, 'human_requested');
  assert.equal(result.payload.automation_epoch, 7);
  assert.equal(result.payload.source_revision, 12);
  assert.equal(result.payload.order, undefined);
});
