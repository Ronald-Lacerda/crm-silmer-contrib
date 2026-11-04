import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { briefingToFicha } from '../modules/orders/src/domain/ficha.js';

// VND-L02: what the Vendedor learned from the real conversations of
// 29/10/2026 (AGT-01..05, ORC-03). The Code nodes of the published snapshot
// run here with synthetic customers and companies; the model's extraction is
// given explicitly, so these tests cover the workflow's own rules and nets,
// not OpenAI's understanding.
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

const DEFERRED = 'Definir com o vendedor';
const PRICE_DEFERRAL =
  'Quem passa o valor é o vendedor, e pra ele já te mandar o preço certinho me conta: ';
const IMAGE_ACK = 'Recebi sua imagem, já deixei aqui para o vendedor ver.';
const ART_QUESTION = 'Você já tem a arte (ou logo) pronta?';
const FABRIC_QUESTION =
  'Qual tecido você prefere: algodão, poliéster ou dry fit, ou outro?';
const IMAGE_ART_QUESTION =
  'Essa imagem já é a arte pronta para aplicar na peça?';
// Thursday 29/10/2026, 10:00 in São Paulo (UTC-3).
const THURSDAY_MORNING = '2026-10-29T13:00:00.000Z';

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
      $execution: { id: 'synthetic-aprendizados-l02' },
    },
  );
  return JSON.parse(JSON.stringify(result.json));
}

/**
 * @param {string} text @param {any} [inbound] @param {any} [event]
 * @param {any} [item] the node input (the media steps' output)
 * @param {Record<string, any>} [extra] more upstream nodes
 */
function context(text, inbound = {}, event = {}, item = null, extra = {}) {
  const crm = {
    accepted: true,
    conversation_id: 'conversation-sintetica',
    automation_epoch: 1,
    source_revision: 3,
    automation_message_count: 2,
    automation_message_cap: 15,
    briefing: {},
    recent_messages: [],
    subjects: [],
    source_subject_ids: [],
    sellers: ['Vendedor Sintético'],
    ...inbound,
  };
  return run('Montar contexto da IA (MVP)', item ?? crm, {
    'CRM - Registrar inbound (MVP)': crm,
    'Normalizar evento WhatsApp (MVP)': {
      channel: 'whatsapp',
      event_id: 'wamid.sintetico-atual',
      from: '5500000000042',
      phone_number_id: 'synthetic-line',
      text,
      customer_name: 'Cliente Sintético',
      message_type: 'text',
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

// Item 1 — the first price question is deferred, the second hands off.

test('VND-L04: greeting asks only missing facts and preserves the current patch', () => {
  for (const briefing of [{ product_type: 'camisetas' }, {}]) {
    const result = decide(context('Quero camisas brancas', { briefing }), {
      briefing_patch: { product_type: 'camisetas', colors: 'branca' },
      reply_text: 'Qual é o seu nome e o que você quer personalizar?',
      asked_field: 'customer_name',
    });
    assert.equal(result.handoff_required, false);
    assert.match(
      result.reply_text,
      /Sou a assistente virtual da Silmer\. Qual é o seu nome\?$/u,
    );
    assert.doesNotMatch(result.reply_text, /o que você quer personalizar/u);
    assert.equal(result.briefing_patch.colors, 'branca');
  }
  const unknown = decide(context('Oi'), {
    asked_field: 'customer_name',
    reply_text: 'Qual é o seu nome e o que você quer personalizar?',
  });
  assert.match(
    unknown.reply_text,
    /Qual é o seu nome e o que você quer personalizar/u,
  );
});

test('VND-L04: greeting retains capability acknowledgement and returning welcome', () => {
  const result = decide(
    context('Vocês fazem camisetas?', {
      briefing: { product_type: 'camisetas' },
      contact_context: { previous_cycles: 1, previous_orders_count: 1 },
    }),
    { asked_field: 'customer_name' },
  );
  assert.match(result.reply_text, /Que bom falar com você de novo/u);
  assert.match(result.reply_text, /Vou anotar para o vendedor confirmar isso/u);
  assert.match(result.reply_text, /Qual é o seu nome\?$/u);
});

test('VND-L04: unresolved image gets a contextual question without inferring art', () => {
  for (const field of ['product_model', 'artwork_status']) {
    const result = decide(
      context(
        '',
        {
          briefing: { ...shirtWithout(field), next_required_field: field },
          recent_messages: [
            {
              sender_type: 'ai',
              text:
                field === 'artwork_status'
                  ? ART_QUESTION
                  : 'Qual modelo você quer?',
            },
          ],
        },
        {
          message_type: 'image',
          media_kind: 'image',
          media_source: 'whatsapp',
        },
        { media_kind: 'image', media_unreadable: true },
      ),
      {
        answer_status: 'unclear',
        briefing_patch:
          field === 'artwork_status'
            ? { artwork_status: 'cliente envia a arte' }
            : {},
      },
    );
    assert.equal(result.handoff_required, false);
    assert.match(result.reply_text, /^Recebi sua imagem/u);
    assert.ok(
      result.reply_text.includes(
        field === 'artwork_status'
          ? IMAGE_ART_QUESTION
          : 'Qual é o modelo da peça na imagem?',
      ),
    );
    assert.equal(result.briefing_patch[field], undefined);
    assert.equal(result.briefing_patch.next_required_field, field);
    assert.doesNotMatch(result.briefing_patch.briefing_status, /failed/u);
  }
});

test('VND-L04: art image confirmation accepts yes but a reference stays unconfirmed', () => {
  for (const text of ['Sim', 'É só uma referência']) {
    const result = decide(
      context(text, {
        briefing: {
          ...shirtWithout('artwork_status'),
          next_required_field: 'artwork_status',
        },
        recent_messages: [
          { sender_type: 'ai', text: IMAGE_ACK + ' ' + IMAGE_ART_QUESTION },
        ],
      }),
      { answer_status: 'answered' },
    );
    if (text === 'Sim')
      assert.equal(
        result.briefing_patch.artwork_status,
        'cliente envia a arte',
      );
    else
      assert.notEqual(
        result.briefing_patch.artwork_status,
        'cliente envia a arte',
      );
  }
});

test('VND-L04: a second image does not repeat the previous contextual question', () => {
  for (const field of ['artwork_status', 'product_model']) {
    const previous =
      IMAGE_ACK +
      ' ' +
      (field === 'artwork_status'
        ? IMAGE_ART_QUESTION
        : 'Qual é o modelo da peça na imagem? Pode dizer com suas palavras.');
    const result = decide(
      context(
        '',
        {
          briefing: { ...shirtWithout(field), next_required_field: field },
          recent_messages: [{ sender_type: 'ai', text: previous }],
        },
        {
          message_type: 'image',
          media_kind: 'image',
          media_source: 'whatsapp',
        },
        { media_kind: 'image' },
      ),
      { answer_status: 'unclear' },
    );
    assert.equal(result.handoff_required, false);
    assert.notEqual(result.reply_text, previous);
    assert.equal(result.briefing_patch[field], undefined);
    assert.equal(result.briefing_patch.next_required_field, field);
  }
});

test('VND-L04: image and first price question retain deferral and the same pending field', () => {
  const result = decide(
    context(
      'Quanto fica?',
      {
        briefing: {
          ...shirtWithout('artwork_status'),
          next_required_field: 'artwork_status',
        },
      },
      { message_type: 'image', media_kind: 'image', media_source: 'whatsapp' },
      { media_kind: 'image' },
    ),
    { asks_price: true },
  );
  assert.equal(result.handoff_required, false);
  assert.match(result.reply_text, /^Recebi sua imagem/u);
  assert.ok(result.reply_text.includes(PRICE_DEFERRAL));
  assert.match(result.reply_text, /essa imagem já é a arte pronta/u);
  assert.equal(result.briefing_patch.artwork_status, undefined);
});

test('VND-L04: no praise for wanting a product, including a comma before the question', () => {
  for (const praise of [
    'Que bom que você quer personalizar camisetas!',
    'Que legal que você quer camisetas,',
  ]) {
    const result = decide(
      context('Camisetas', { briefing: shirtWithout('colors') }),
      {
        reply_text: praise + ' Qual a cor da peça?',
        asked_field: 'colors',
      },
    );
    assert.equal(result.reply_text, 'Qual a cor da peça?');
  }
});

test('VND-L04: urgent and complaint handoffs do not promise immediate service', () => {
  for (const reason of ['urgency', 'complaint']) {
    const result = decide(
      context(
        'Preciso de ajuda',
        {},
        { occurred_at: '2026-11-03T23:00:00.000Z' },
      ),
      {
        handoff_required: true,
        handoff_reason: reason,
      },
    );
    assert.equal(result.handoff_required, true);
    assert.equal(result.handoff_reason, reason);
    assert.match(result.reply_text, /aqui mesmo/u);
    assert.match(result.reply_text, /amanhã às 9h/u);
    assert.doesNotMatch(result.reply_text, /agora|imediatamente/u);
  }
  const deadline = decide(
    context('Preciso amanhã', {
      briefing: { ...shirtWithout(), needed_by: 'amanhã' },
    }),
  );
  assert.equal(deadline.trigger, 'deadline_urgency');
  assert.doesNotMatch(deadline.reply_text, /agora|imediatamente/u);
});

test('item 1: the first price question asks the next point instead of handing off', () => {
  const result = decide(
    context('Quanto fica cada camiseta?', {
      briefing: shirtWithout('colors'),
    }),
    { asks_price: true, reply_text: 'Ótima pergunta! Qual a cor da peça?' },
  );
  assert.equal(result.handoff_required, false);
  assert.equal(result.trigger, null);
  assert.equal(result.reply_text, PRICE_DEFERRAL + 'qual a cor da peça?');
  assert.doesNotMatch(result.reply_text, /Ótima pergunta/u);
  assert.equal(result.briefing_patch.briefing_status, 'quote_price_collecting');
  assert.equal(result.briefing_patch.next_required_field, 'colors');
});

test('item 1: a large volume ("preço para 300 e 500 unidades") follows the same rule', () => {
  const first = decide(
    context('Qual o preço para 300 e 500 unidades?', {
      briefing: shirtWithout('quantity'),
    }),
    { asks_price: true },
  );
  assert.equal(first.handoff_required, false);
  assert.match(first.reply_text, /^Quem passa o valor é o vendedor/u);
  assert.match(first.reply_text, /quantas peças você precisa\?$/u);
});

test('item 1: the second price question hands off as negotiation, by the marker or by the history', () => {
  const marked = decide(
    context('E aí, quanto fica?', {
      briefing: shirtWithout('colors', 'needed_by'),
    }),
    { asks_price: true },
  );
  assert.equal(marked.handoff_required, false);

  const again = decide(
    context('E aí, quanto fica?', {
      briefing: {
        ...shirtWithout('colors', 'needed_by'),
        briefing_status: 'quote_price_collecting',
      },
    }),
    { asks_price: true },
  );
  assert.equal(again.trigger, 'price');
  assert.equal(again.handoff_reason, 'negotiation');
  assert.match(again.reasoning, /Motivo: Perguntou o valor\./u);

  // No order holds the briefing yet (the patch is not saved): the customer's
  // earlier question, before the last reply, is the memory.
  const byHistory = decide(
    context('Mas quanto custa?', {
      recent_messages: [
        { sender_type: 'customer', text: 'Oi, quanto custa?' },
        {
          sender_type: 'ai',
          text:
            PRICE_DEFERRAL +
            'qual é o seu nome e o que você quer personalizar?',
        },
        { sender_type: 'customer', text: 'Mas quanto custa?' },
      ],
    }),
    { asks_price: true },
  );
  assert.equal(byHistory.trigger, 'price');
  assert.equal(byHistory.handoff_reason, 'negotiation');
});

test('item 1: a price question already asked shows in the summary when the ficha completes', () => {
  const result = decide(
    context('20/11', {
      briefing: {
        ...shirtWithout('needed_by'),
        briefing_status: 'quote_price_collecting',
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: '20/11' } },
  );
  assert.equal(result.trigger, 'briefing_complete');
  assert.equal(result.handoff_reason, 'briefing_complete');
  assert.match(result.reasoning, /Perguntou o valor\./u);

  const withoutPrice = decide(
    context('20/11', {
      briefing: {
        ...shirtWithout('needed_by'),
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: '20/11' } },
  );
  assert.equal(withoutPrice.trigger, 'briefing_complete');
  assert.doesNotMatch(withoutPrice.reasoning, /Perguntou o valor/u);
});

test('item 1 negative: a quote request is not a price question, and a model price never goes out', () => {
  const quote = decide(context('Vocês fazem orçamento?'), {
    asks_price: true,
    reply_text: 'Claro! Qual é o seu nome?',
    asked_field: 'customer_name',
  });
  assert.equal(quote.reply_text, 'Claro! Qual é o seu nome?');
  assert.doesNotMatch(quote.briefing_patch?.briefing_status ?? '', /price_/u);

  const unsafe = decide(
    context('Quanto custa?', { briefing: shirtWithout('colors') }),
    { asks_price: true, reply_text: 'Fica 30 reais cada. Qual a cor?' },
  );
  assert.equal(unsafe.handoff_required, false);
  assert.doesNotMatch(unsafe.reply_text, /reais|30/u);
  assert.match(unsafe.reply_text, /^Quem passa o valor/u);
});

test('item 1 negative: two price messages of the same burst are one question, not a repeat', () => {
  const ctx = context(
    'e o frete?',
    {
      briefing: shirtWithout('colors'),
      recent_messages: [
        { sender_type: 'ai', text: 'Quantas peças você precisa?' },
        { sender_type: 'customer', text: 'quanto custa?', external_id: 'w1' },
        { sender_type: 'customer', text: 'e o frete?', external_id: 'w2' },
      ],
    },
    { event_id: 'w2' },
  );
  const result = decide(ctx, { asks_price: true });
  assert.equal(result.handoff_required, false);
  assert.match(result.reply_text, /^Quem passa o valor/u);
});

// Item 2 — where the art comes from is asked, never an offer to create it.

test('item 2: the artwork is asked after where it goes, without offering to create it', () => {
  const ctx = context('Na frente', {
    briefing: shirtWithout('artwork_status', 'needed_by'),
  });
  assert.equal(ctx.next_point, 'artwork_status');
  assert.ok(ctx.prompt.includes('Como perguntar: ' + ART_QUESTION + '\n'));
  const prompt = nodes.get('Atendente virtual Silmer (MVP)').parameters.options
    .systemMessage;
  assert.doesNotMatch(
    prompt,
    /precisa que a gente crie|quer que a gente crie/u,
  );
  assert.match(prompt, /Nunca ofereça criar a arte/u);
});

test('item 2: each answer is recorded as a phrase the CRM projection reads', () => {
  /** @param {string} text @param {any} [patch] @param {string} [status] */
  const answer = (text, patch = {}, status = 'answered') =>
    decide(
      context(text, {
        briefing: {
          ...shirtWithout('artwork_status', 'needed_by'),
          next_required_field: 'artwork_status',
        },
        // VND-L03: a bare "Sim" counts only after the art question, so the
        // history now carries the bot's last reply (ADR 051 known false
        // positive; the negative case is in n8n-vendedor-l03.test.js).
        recent_messages: [{ sender_type: 'ai', text: ART_QUESTION }],
      }),
      {
        answer_status: status,
        briefing_patch: patch,
        reply_text: 'Para quando você precisa?',
        asked_field: 'needed_by',
      },
    );

  const has = answer('Já tenho a logo sim');
  assert.equal(has.briefing_patch.artwork_status, 'cliente envia a arte');
  const yes = answer('Sim');
  assert.equal(yes.briefing_patch.artwork_status, 'cliente envia a arte');
  const plain = answer('Vai lisa');
  assert.equal(plain.briefing_patch.artwork_status, 'sem estampa');
  const create = answer('Quero que vocês criem', {
    artwork_status: 'Silmer cria a arte',
  });
  assert.equal(create.briefing_patch.artwork_status, 'Silmer cria a arte');
  assert.match(
    create.reply_text,
    /^Vou anotar para o vendedor confirmar isso\./u,
  );

  for (const [result, origin] of [
    [has, 'feito_pelo_cliente'],
    [plain, 'sem_estampa'],
    [create, 'feito_pela_silmer'],
  ]) {
    const ficha = briefingToFicha({
      ...shirtWithout('artwork_status'),
      ...result.briefing_patch,
    });
    const artwork = /** @type {Record<string, boolean>} */ (
      ficha.artwork ?? {}
    );
    assert.equal(artwork[origin], true, origin);
  }
});

test('item 2: "não tenho" is left to the seller with a note, never "Silmer cria a arte"', () => {
  const result = decide(
    context('Ainda não tenho', {
      briefing: {
        ...shirtWithout('artwork_status', 'needed_by'),
        next_required_field: 'artwork_status',
      },
    }),
    {
      answer_status: 'answered',
      // The model's own phrasing must not decide for the seller.
      briefing_patch: { artwork_status: 'Silmer cria a arte' },
      reply_text: 'Para quando você precisa?',
      asked_field: 'needed_by',
    },
  );
  assert.equal(result.briefing_patch.artwork_status, DEFERRED);
  assert.match(result.briefing_patch.notes, /Cliente ainda não tem a arte/u);
  const ficha = briefingToFicha({
    ...shirtWithout('artwork_status'),
    ...result.briefing_patch,
  });
  assert.equal(ficha.artwork?.feito_pela_silmer, false);

  // The seller sees it in the summary of the handoff.
  const handoff = decide(
    context('20/11', {
      briefing: {
        ...shirtWithout('needed_by'),
        ...result.briefing_patch,
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: '20/11' } },
  );
  assert.equal(handoff.trigger, 'briefing_complete');
  assert.match(handoff.reasoning, /Para o vendedor definir: artwork_status/u);
  assert.match(handoff.reasoning, /Dica: [^.]*cliente ainda não tem a arte/u);
});

test("item 2 negative: a reference photo is not the art, an evasive answer is the seller's, a plain piece skips the point", () => {
  const pending = {
    ...shirtWithout('artwork_status', 'needed_by'),
    next_required_field: 'artwork_status',
  };
  const reference = decide(
    context('Vou mandar uma foto de referência', { briefing: pending }),
    {
      answer_status: 'other',
      briefing_patch: { artwork_status: 'cliente envia a arte' },
    },
  );
  assert.equal(reference.briefing_patch.artwork_status, undefined);

  const evasive = decide(context('Tanto faz', { briefing: pending }), {
    answer_status: 'undecided',
  });
  assert.equal(evasive.briefing_patch.artwork_status, DEFERRED);
  assert.equal(evasive.handoff_required, false);
  assert.equal(evasive.briefing_patch.next_required_field, 'needed_by');

  const plainPiece = context('Quero lisa', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'camisetas',
      product_model: 'camiseta comum',
      colors: 'preta',
      quantity: 10,
      fabrics: 'algodão',
      artwork_locations: 'sem aplicação',
    },
  });
  assert.equal(plainPiece.next_point, 'needed_by');
});

// Item 3 — the fabric is asked for clothing only.

test('item 3: a shirt asks the fabric after the quantity, with the three simple options', () => {
  const ctx = context('30', {
    briefing: {
      ...shirtWithout(
        'fabrics',
        'artwork_locations',
        'artwork_status',
        'needed_by',
      ),
    },
  });
  assert.equal(ctx.next_point, 'fabrics');
  assert.ok(ctx.prompt.includes('Como perguntar: ' + FABRIC_QUESTION + '\n'));
  assert.match(
    ctx.prompt,
    /Pontos que ainda faltam, nesta ordem: fabrics \(tecido\), artwork_locations \(onde vai a estampa\), artwork_status \(arte\), needed_by \(para quando\)/u,
  );
  // The longest ficha (the name plus 8 points of a shirt) fits the 15-message cap.
  const result = decide(ctx, { answer_status: 'answered' });
  assert.equal(result.ficha_total, 9);
  assert.ok(result.ficha_total < 15);
});

test('item 3 negative: a cap, a flag and a kit never ask the fabric', () => {
  const cap = context('Pretos', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'bonés',
      product_model: 'boné trucker',
      colors: 'preto',
      quantity: 50,
    },
  });
  assert.equal(cap.next_point, 'artwork_locations');
  assert.doesNotMatch(cap.prompt, /fabrics/u);

  const flag = context('2', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'bandeira',
      product_model: 'bandeira 1 x 1,5 m',
      colors: 'azul',
      quantity: 2,
    },
  });
  assert.doesNotMatch(flag.prompt, /fabrics \(tecido\)/u);

  const abada = context('100', {
    briefing: { customer_name: 'Rafa', product_type: 'abadás', quantity: 100 },
  });
  assert.equal(abada.next_point, 'artwork_locations');
  assert.doesNotMatch(abada.prompt, /fabrics \(tecido\)/u);
});

test('item 3: a fabric the customer already gave is recorded in their words and not asked', () => {
  const pasted = decide(
    context('Malha 100% algodão 260 g, gola redonda, 30 peças', {
      briefing: shirtWithout(
        'fabrics',
        'artwork_locations',
        'artwork_status',
        'needed_by',
      ),
    }),
    { answer_status: 'answered', briefing_patch: { quantity: 30 } },
  );
  assert.equal(pasted.briefing_patch.fabrics, 'Malha 100% algodão 260 g');
  assert.equal(pasted.briefing_patch.next_required_field, 'artwork_locations');

  const dry = decide(
    context('Quero camisa em dry fit', {
      briefing: { customer_name: 'Rafa', briefing_status: 'collecting' },
    }),
    { briefing_patch: { product_type: 'camisas' } },
  );
  assert.equal(dry.briefing_patch.fabrics, 'dry fit');
  assert.ok(!dry.missing_briefing_fields.includes('fabrics'));

  // The CRM takes less than 200 characters.
  const long = decide(
    context('segue a especificação', {
      briefing: shirtWithout('fabrics', 'needed_by'),
    }),
    {
      briefing_patch: {
        fabrics:
          'Malha 100% algodão penteado 30.1 ' + 'fio penteado '.repeat(20),
      },
    },
  );
  assert.ok(long.briefing_patch.fabrics.length < 200);
  assert.match(long.briefing_patch.fabrics, /^Malha 100% algodão/u);
});

test("item 3 negative: an unwanted fabric is not recorded, and an evasive answer is the seller's", () => {
  const unwanted = decide(
    context('Não quero poliéster', {
      briefing: { customer_name: 'Rafa', product_type: 'camisetas' },
    }),
    {},
  );
  assert.equal(unwanted.briefing_patch.fabrics, undefined);

  const pending = {
    ...shirtWithout(
      'fabrics',
      'artwork_locations',
      'artwork_status',
      'needed_by',
    ),
    next_required_field: 'fabrics',
    briefing_status: 'quote_clarifying',
  };
  for (const text of ['tanto faz', 'vocês escolhem', 'qualquer um']) {
    const result = decide(context(text, { briefing: pending }), {
      answer_status: 'undecided',
    });
    assert.equal(result.briefing_patch.fabrics, DEFERRED, text);
    assert.equal(result.handoff_required, false, text);
    assert.equal(result.trigger, null, text);
  }
});

// Item 4 — an image is received for the seller, never a failed answer.

test('item 4: an image the bot cannot open is acknowledged with the next question, not counted', () => {
  const ctx = context(
    '',
    {
      briefing: {
        ...shirtWithout('colors'),
        next_required_field: 'colors',
        briefing_status: 'quote_clarifying',
      },
    },
    { message_type: 'image', media_kind: 'image', media_source: 'whatsapp' },
    { media_kind: 'image', media_unreadable: true },
  );
  assert.equal(ctx.image_turn, true);
  assert.doesNotMatch(ctx.prompt, /não consegui abrir/u);
  assert.match(ctx.prompt, /uma imagem, que ficou para o vendedor ver/u);
  const result = decide(ctx, {
    answer_status: 'unclear',
    reply_text: 'Não consegui identificar os itens nas imagens. Pode escrever?',
  });
  assert.equal(result.handoff_required, false);
  assert.equal(result.trigger, null);
  assert.equal(result.reply_text, IMAGE_ACK + ' Qual a cor da peça?');
  assert.equal(result.briefing_patch.briefing_status, 'quote_clarifying');
});

test('item 4: a readable image with a caption takes the caption as the message', () => {
  const ctx = context(
    'quero nessa cor',
    { briefing: shirtWithout('colors', 'needed_by') },
    { message_type: 'image', media_kind: 'image', media_source: 'whatsapp' },
    null,
  );
  assert.equal(ctx.current_text, 'quero nessa cor');
  assert.equal(ctx.image_turn, true);
  const result = decide(ctx, {
    answer_status: 'answered',
    briefing_patch: { colors: 'azul-marinho' },
  });
  assert.equal(result.briefing_patch.colors, 'azul-marinho');
  assert.match(
    result.reply_text,
    /^Recebi sua imagem, já deixei aqui para o vendedor ver\./u,
  );
});

test('item 4 negative: an audio still asks to write, and a sticker is not an image turn', () => {
  const audio = context(
    '',
    { briefing: shirtWithout('colors') },
    { message_type: 'audio', media_kind: 'audio', media_source: 'whatsapp' },
    { media_kind: 'audio', media_unreadable: true },
  );
  assert.equal(audio.image_turn, false);
  assert.match(audio.prompt, /um áudio que não consegui abrir/u);

  const sticker = context(
    '[figurinha]',
    { briefing: shirtWithout('colors') },
    { message_type: 'image', media_kind: '' },
  );
  assert.equal(sticker.image_turn, false);
});

// Item 5 — a burst gets one reply that considers all its messages.

test('item 5: the newest message of a burst answers all of them at once', () => {
  const ctx = context(
    'Meu nome é Rafa',
    {
      recent_messages: [
        { sender_type: 'ai', text: 'Oi! Qual é o seu nome?' },
        {
          sender_type: 'customer',
          text: 'Quero 20 camisetas',
          external_id: 'w1',
        },
        { sender_type: 'customer', text: 'Meu nome é Rafa', external_id: 'w2' },
      ],
    },
    { event_id: 'w2' },
  );
  assert.equal(ctx.burst_size, 2);
  assert.equal(ctx.current_text, 'Quero 20 camisetas.\nMeu nome é Rafa.');
  assert.match(
    ctx.prompt,
    /O cliente mandou 2 mensagens seguidas; responda uma vez só/u,
  );
  assert.match(ctx.prompt, /"Quero 20 camisetas"/u);

  // An image earlier in the burst makes it an image turn.
  const images = context(
    'Essas são as referências',
    {
      recent_messages: [
        { sender_type: 'ai', text: 'Qual a cor da peça?' },
        { sender_type: 'customer', type: 'image', text: '', external_id: 'w1' },
        { sender_type: 'customer', type: 'image', text: '', external_id: 'w2' },
        {
          sender_type: 'customer',
          text: 'Essas são as referências',
          external_id: 'w3',
        },
      ],
    },
    { event_id: 'w3' },
  );
  assert.equal(images.burst_size, 3);
  assert.equal(images.image_turn, true);
});

test('item 5 negative: messages answered by a reply are not part of the turn', () => {
  const ctx = context(
    'Branca',
    {
      recent_messages: [
        {
          sender_type: 'customer',
          text: 'Quero 20 camisetas',
          external_id: 'w1',
        },
        { sender_type: 'ai', text: 'Qual a cor da peça?' },
        { sender_type: 'customer', text: 'Branca', external_id: 'w2' },
      ],
    },
    { event_id: 'w2' },
  );
  assert.equal(ctx.burst_size, 1);
  assert.equal(ctx.current_text, 'Branca');
  assert.doesNotMatch(ctx.prompt, /mensagens seguidas/u);
});

test('item 5: the context reads the conversation as reread after the window', () => {
  const reread = {
    accepted: true,
    duplicate: true,
    conversation_id: 'conversation-sintetica',
    automation_epoch: 1,
    source_revision: 3,
    automation_message_count: 2,
    automation_message_cap: 15,
    briefing: { customer_name: 'Rafa', product_type: 'camisetas' },
    recent_messages: [],
    subjects: [],
    source_subject_ids: [],
    sellers: [],
  };
  const ctx = context('oi', {}, {}, null, {
    'CRM - Reler conversa (MVP)': reread,
  });
  assert.equal(ctx.briefing.customer_name, 'Rafa');
});

test('item 5: the workflow waits, rereads with the same inbound event and goes on only while newest', () => {
  /** @param {string} source @param {number} [output] */
  const targets = (source, output = 0) =>
    (snapshot.connections[source]?.main?.[output] ?? []).map(
      (/** @type {any} */ edge) => edge.node,
    );
  assert.deepEqual(targets('Rotear conversa registrada (MVP)', 0), [
    'Aguardar mensagens seguidas (MVP)',
  ]);
  const wait = nodes.get('Aguardar mensagens seguidas (MVP)');
  assert.equal(wait.type, 'n8n-nodes-base.wait');
  assert.deepEqual(wait.parameters, {
    resume: 'timeInterval',
    amount: 8,
    unit: 'seconds',
  });
  assert.deepEqual(targets(wait.name), ['CRM - Reler conversa (MVP)']);

  const reread = nodes.get('CRM - Reler conversa (MVP)');
  const inbound = nodes.get('CRM - Registrar inbound (MVP)');
  assert.equal(reread.parameters.url, inbound.parameters.url);
  const header = (/** @type {any} */ node, /** @type {string} */ name) =>
    node.parameters.headerParameters.parameters.find(
      (/** @type {any} */ item) => item.name === name,
    ).value;
  // The same idempotency key and payload: a replay with no new effect.
  assert.equal(
    header(reread, 'Idempotency-Key'),
    "={{ $('Preparar inbound CRM (MVP)').item.json.idempotency_key }}",
  );
  assert.equal(
    reread.parameters.jsonBody,
    "={{ $('Preparar inbound CRM (MVP)').item.json.payload }}",
  );
  assert.deepEqual(targets(reread.name), ['Ainda é a última mensagem? (MVP)']);

  const check = nodes.get('Ainda é a última mensagem? (MVP)');
  const condition = check.parameters.conditions.conditions[0].leftValue;
  assert.match(condition, /\$json\.mode === 'ai_active'/u);
  assert.match(
    condition,
    /\$json\.source_revision === \$\('CRM - Registrar inbound \(MVP\)'\)\.item\.json\.source_revision/u,
  );
  assert.deepEqual(targets(check.name, 0), ['Ler mídia da mensagem? (MVP)']);
  assert.deepEqual(targets(check.name, 1), [
    'Responder no chat do site? (MVP)',
  ]);
  // The persistence (and the WAHA acknowledgement hung on it) comes before the wait.
  assert.deepEqual(targets('CRM - Registrar inbound (MVP)'), [
    'Acompanhar intenção de compra? (OA)',
    'Rotear conversa registrada (MVP)',
  ]);
  assert.ok(
    nodes.get('Acompanhar intenção de compra? (OA)').position[1] >
      nodes.get('Rotear conversa registrada (MVP)').position[1],
  );
});

test('item 5: a site turn superseded during the window only acknowledges receipt', () => {
  const output = run(
    'Site - Responder no chat (MVP)',
    {},
    {
      'CRM - Registrar inbound (MVP)': { duplicate: false },
      'CRM - Reler conversa (MVP)': { accepted: true, source_revision: 4 },
    },
  ).output;
  assert.equal(output, 'Recebi a sua mensagem!');
});

// Item 7 — a complete ficha needed today or tomorrow is urgent.

test('item 7: a deadline today or tomorrow hands the complete ficha off as urgency', () => {
  const tomorrow = decide(
    context('Para amanhã', {
      briefing: {
        ...shirtWithout('needed_by'),
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: 'amanhã' } },
  );
  assert.equal(tomorrow.briefing_patch.needed_by, 'amanhã (30/10/2026)');
  assert.equal(tomorrow.trigger, 'deadline_urgency');
  assert.equal(tomorrow.handoff_reason, 'urgency');
  assert.match(tomorrow.reply_text, /^Entendi a urgência!/u);
  assert.match(
    tomorrow.reasoning,
    /Motivo: Urgência: precisa para amanhã \(30\/10\/2026\)\./u,
  );

  const today = decide(
    context('29/10', {
      briefing: {
        ...shirtWithout('needed_by'),
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: '29/10' } },
  );
  assert.equal(today.handoff_reason, 'urgency');
});

test('item 7 negative: a later deadline is a plain complete ficha; an incomplete one is not urgent yet', () => {
  const later = decide(
    context('20/11', {
      briefing: {
        ...shirtWithout('needed_by'),
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: '20/11' } },
  );
  assert.equal(later.trigger, 'briefing_complete');

  const incomplete = decide(
    context('Para amanhã', {
      briefing: {
        ...shirtWithout('needed_by', 'colors'),
        next_required_field: 'needed_by',
      },
    }),
    { answer_status: 'answered', briefing_patch: { needed_by: 'amanhã' } },
  );
  assert.equal(incomplete.handoff_required, false);
});

// Item 8 — partnership, resale, invoice: the seller answers each question.

test('item 8: partnership and resale questions hand off with the questions listed for the seller', () => {
  const text =
    'Boa tarde! Sou da Loja Sintética. Vocês fazem parceria? Qual o preço para revendedor? Emitem nota fiscal?';
  const result = decide(context(text), {
    asks_price: true,
    reply_text: 'Ótima pergunta! Qual é o seu nome?',
  });
  assert.equal(result.trigger, 'partnership');
  // VND-L03: this harness is a CRM without contact_context (no capability
  // announced), so the reason stays human_requested; against the CRM of this
  // round it is partnership (n8n-vendedor-l03.test.js).
  assert.equal(result.handoff_reason, 'human_requested');
  assert.doesNotMatch(result.reply_text, /Ótima pergunta/u);
  assert.match(
    result.reply_text,
    /^Anotei suas perguntas para o vendedor responder uma a uma\./u,
  );
  assert.match(
    result.reasoning,
    /Perguntas do cliente: • Vocês fazem parceria\? • Qual o preço para revendedor\? • Emitem nota fiscal\?/u,
  );
  assert.match(result.reasoning, /Dica: [^.]*Possível parceria\/revenda/u);

  for (const other of [
    'Vocês enviam direto para o meu cliente?',
    'Tem preço de atacado?',
    'Vocês têm fotos das peças que já fizeram?',
  ]) {
    assert.equal(decide(context(other)).trigger, 'partnership', other);
  }
});

test('item 8 negative: an ordinary order or a reference photo is not a partnership; resale only when said', () => {
  for (const text of [
    'Quero 30 camisetas para a minha loja',
    'Vou mandar a foto da peça que eu quero',
  ]) {
    assert.notEqual(decide(context(text)).trigger, 'partnership', text);
  }
  const guessed = decide(context('Quero 50 camisetas para a equipe'), {
    briefing_patch: { product_type: 'camisetas', purchase_profile: 'revenda' },
  });
  assert.equal('purchase_profile' in guessed.briefing_patch, false);
  const said = decide(context('Quero 50 camisetas para revender'), {
    briefing_patch: { product_type: 'camisetas', purchase_profile: 'revenda' },
  });
  assert.equal(said.trigger, 'partnership');
  assert.equal(said.briefing_patch.purchase_profile, 'revenda');
});

// Item 9 — no praise of the customer's choice.

test('item 9: praise of the choice is dropped and the question stays', () => {
  const ctx = context('Preto e branco', {
    briefing: shirtWithout('colors', 'quantity'),
  });
  /** @param {string} reply */
  const said = (reply) =>
    decide(ctx, {
      answer_status: 'answered',
      briefing_patch: { colors: 'preto e branco' },
      reply_text: reply,
      asked_field: 'quantity',
    }).reply_text;
  assert.equal(
    said('Ótima escolha! Quantas peças você precisa?'),
    'Quantas peças você precisa?',
  );
  assert.equal(
    said('Preto e branco combinam bem, e quantas peças você precisa?'),
    'Quantas peças você precisa?',
  );
  assert.equal(
    said('Que legal, vai ficar muito bonita! Quantas peças você precisa?'),
    'Quantas peças você precisa?',
  );
  // Nothing left to ask: the question of the rhythm.
  assert.equal(said('Vai ficar linda!'), 'Quantas peças você precisa?');
});

test('item 9 negative: a plain friendly reply is kept, and the customer words go to the ficha as said', () => {
  const result = decide(
    context('Camisa Streetwar', {
      briefing: {
        customer_name: 'Rafa',
        product_type: 'camisas',
        next_required_field: 'product_model',
      },
    }),
    {
      answer_status: 'answered',
      briefing_patch: { product_model: 'camisa Streetwar' },
      reply_text: 'Que legal! Qual a cor da peça?',
      asked_field: 'colors',
    },
  );
  assert.equal(result.reply_text, 'Que legal! Qual a cor da peça?');
  assert.equal(result.briefing_patch.product_model, 'camisa Streetwar');
  const prompt = nodes.get('Atendente virtual Silmer (MVP)').parameters.options
    .systemMessage;
  assert.match(prompt, /Não elogie a escolha do cliente/u);
  assert.match(prompt, /Não repita erros de digitação dele/u);
});

// Item 10 — the last 30 minutes of the day say a seller may answer next time.

test('item 10: a handoff in the last 30 minutes says a seller may answer at the next opening', () => {
  /** @param {string} occurred_at */
  const notice = (occurred_at) =>
    decide(context('Quero falar com um atendente', {}, { occurred_at }), {
      person_request: 'generic',
    }).reply_text;
  // Wednesday 28/10 17:45: tomorrow at 9h.
  assert.match(
    notice('2026-10-28T20:45:00.000Z'),
    /está perto de acabar\. Se não der tempo hoje, um vendedor te responde a partir de amanhã às 9h\.$/u,
  );
  // Saturday 07/11 11:40: Monday. VND-L03: this was Saturday 31/10, but
  // Monday 02/11/2026 is Finados, a holiday (n8n-vendedor-l03.test.js).
  assert.match(
    notice('2026-11-07T14:40:00.000Z'),
    /Se não der tempo hoje, um vendedor te responde a partir de segunda-feira às 9h\.$/u,
  );
  // The content handoff (a document) gets it too.
  const media = run(
    'Preparar handoff de conteúdo (MVP)',
    {
      conversation_id: 'conversation-sintetica',
      automation_epoch: 1,
      source_revision: 4,
    },
    {
      'Normalizar evento WhatsApp (MVP)': {
        message_type: 'document',
        channel: 'whatsapp',
        occurred_at: '2026-10-30T20:50:00.000Z',
      },
    },
  );
  assert.match(
    media.payload.handoff.notice.text,
    /a partir de amanhã às 9h\.$/u,
  );
});

test('item 10 negative: before the last 30 minutes, and a reply that is not a transfer, get no line', () => {
  const before = decide(
    context(
      'Quero falar com um atendente',
      {},
      { occurred_at: '2026-10-28T20:29:00.000Z' },
    ),
    { person_request: 'generic' },
  );
  assert.doesNotMatch(before.reply_text, /horário/u);
  const reply = decide(
    context(
      'Branca',
      { briefing: shirtWithout('colors', 'quantity') },
      { occurred_at: '2026-10-28T20:45:00.000Z' },
    ),
    {
      answer_status: 'answered',
      briefing_patch: { colors: 'branca' },
      reply_text: 'Quantas peças você precisa?',
      asked_field: 'quantity',
    },
  );
  assert.equal(reply.handoff_required, false);
  assert.equal(reply.reply_text, 'Quantas peças você precisa?');
});
