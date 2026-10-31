import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import {
  briefingToFicha,
  NOT_APPLICABLE,
} from '../modules/orders/src/domain/ficha.js';

// What the Vendedor learned from five real conversations of 28/10/2026
// (CHAN-WA-01). The actual Code nodes of the published snapshot run here with
// synthetic customers; the model's extraction is given explicitly, so these
// tests cover the workflow's own rules and nets, not OpenAI's understanding.
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

const MODEL_QUESTION =
  'Qual modelo você quer: camiseta comum, manga longa, polo, regata, abadá, baby look ou outro?';
const SITE_REFERENCE =
  'Olá! Vi no site a referência "Camisa de e-sports com frente e costas personalizadas" e quero algo parecido.';
const AFTER_HOURS =
  'Nosso horário de atendimento é de segunda a sexta, das 9h às 18h, e sábado, das 9h às 12h.';
// Wednesday 28/10/2026, 20:01 in São Paulo (UTC-3).
const WEDNESDAY_NIGHT = '2026-10-28T23:01:00.000Z';

/** @param {string} name @param {any} item @param {Record<string, any>} upstream */
function run(name, item, upstream = {}) {
  const result = vm.runInNewContext(
    `(() => {\n${nodes.get(name).parameters.jsCode}\n})()`,
    {
      $json: item,
      $: (/** @type {string} */ key) => {
        if (!(key in upstream)) throw new Error(`Missing upstream ${key}`);
        return { item: { json: upstream[key] } };
      },
      $execution: { id: 'synthetic-aprendizados' },
    },
  );
  return JSON.parse(JSON.stringify(result.json));
}

/** @param {string} text @param {any} [inbound] @param {any} [event] */
function context(text, inbound = {}, event = {}) {
  const crm = {
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
  return run('Montar contexto da IA (MVP)', crm, {
    'CRM - Registrar inbound (MVP)': crm,
    'Normalizar evento WhatsApp (MVP)': {
      channel: 'whatsapp',
      from: '5500000000042',
      phone_number_id: 'synthetic-line',
      text,
      customer_name: 'Cliente Sintético',
      message_type: 'text',
      ...event,
    },
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

/** @param {string} text */
const sentences = (text) =>
  (text.match(/[^.!?]+[.!?]*/gu) ?? []).map((part) => part.trim());

// A shirt order with everything but the given points.
/** @param {...string} without */
function shirtWithout(...without) {
  /** @type {Record<string, any>} */
  const briefing = {
    customer_name: 'Rafa',
    product_type: 'camisetas',
    product_model: 'camiseta comum',
    colors: 'branca',
    quantity: 30,
    // VND-L02 items 2 and 3: the fabric and the artwork are points of a shirt.
    fabrics: 'algodão',
    artwork_locations: 'frente',
    artwork_status: 'cliente envia a arte',
    needed_by: '20/11',
  };
  for (const field of without) delete briefing[field];
  return briefing;
}

test('item 2: "Futebol" answers the clothing model in the customer words, without repeating the question', () => {
  const ctx = context('Futebol', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'camisas',
      next_required_field: 'product_model',
      briefing_status: 'quote_ignored',
    },
    recent_messages: [
      { sender_type: 'ai', text: MODEL_QUESTION },
      { sender_type: 'customer', text: 'Futebol' },
    ],
  });
  // The model of the real conversation: purpose instead of the model, same question again.
  const result = decide(ctx, {
    reply_text: MODEL_QUESTION,
    asked_field: 'product_model',
    answer_status: 'unclear',
    briefing_patch: { purpose: 'futebol' },
  });
  assert.equal(result.briefing_patch.product_model, 'camisa de futebol');
  assert.equal('purpose' in result.briefing_patch, false);
  assert.equal(result.handoff_required, false);
  assert.equal(result.trigger, null);
  assert.equal(result.briefing_patch.briefing_status, 'quote_collecting');
  assert.equal(result.briefing_patch.next_required_field, 'colors');
  assert.notEqual(result.reply_text, MODEL_QUESTION);
  assert.doesNotMatch(result.reply_text, /modelo/u);
  assert.match(result.reply_text, /cor/u);
});

test('item 2: other free answers name the model; a long message stays with the model', () => {
  /** @param {string} text */
  const modelFor = (text) =>
    decide(
      context(text, {
        briefing: {
          customer_name: 'Rafa',
          product_type: 'camisetas',
          next_required_field: 'product_model',
        },
      }),
      { answer_status: 'other', asked_field: 'colors' },
    ).briefing_patch.product_model;
  assert.equal(modelFor('de time'), 'camisa de time');
  assert.equal(modelFor('E-sports'), 'camisa de e-sports');
  assert.equal(modelFor('esportiva'), 'camisa esportiva');
  assert.equal(modelFor('quero camisa de futebol'), 'camisa de futebol');
  assert.equal(
    modelFor(
      'olha eu ainda nao sei bem o que vou querer pra essa festa da firma',
    ),
    undefined,
  );
});

test('item 2 negative: "futebol" as a purpose is not a model when the model is not the pending point', () => {
  const result = decide(
    context('é para o time de futebol', {
      briefing: shirtWithout('colors', 'quantity', 'artwork_locations'),
    }),
    {
      answer_status: 'other',
      briefing_patch: { purpose: 'time de futebol' },
    },
  );
  assert.equal(result.briefing_patch.product_model, undefined);
  assert.equal(result.briefing_patch.purpose, 'time de futebol');

  // Nor for a cap: the free model of clothing is only for clothing.
  const cap = decide(
    context('futebol', {
      briefing: {
        customer_name: 'Rafa',
        product_type: 'bonés',
        next_required_field: 'product_model',
      },
    }),
    { answer_status: 'unclear' },
  );
  assert.equal(cap.briefing_patch.product_model, undefined);
});

test('item 2: a football or e-sports shirt names its model and hints full sublimation to the seller only', () => {
  const result = decide(
    // VND-L02 item 1: the price was asked before, so this one hands off.
    context('Quero 20 camisas de futebol, quanto custa?', {
      briefing: { customer_name: 'Rafa', briefing_status: 'price_collecting' },
    }),
    {
      asks_price: true,
      briefing_patch: { product_type: '20 camisas de futebol', quantity: 20 },
    },
  );
  assert.equal(result.trigger, 'price');
  assert.equal(result.briefing_patch.product_model, '20 camisas de futebol');
  assert.equal(result.briefing_patch.artwork_technique, undefined);
  assert.match(
    result.reasoning,
    /Dica: [^.]*camisa de futebol, esportiva ou de e-sports costuma ser sublimação total/u,
  );
  assert.doesNotMatch(result.reply_text, /sublima/u);
});

test('item 3: the site reference message goes to the notes, is an order from scratch and is never an ignored question', () => {
  const briefing = {
    customer_name: 'Rafa',
    product_type: 'camisas',
    product_model: 'camisa de futebol',
    next_required_field: 'colors',
    briefing_status: 'quote_ignored',
  };
  const ctx = context(SITE_REFERENCE, { briefing });
  assert.match(
    ctx.prompt,
    /mensagem pronta do site com a referência "Camisa de e-sports com frente e costas personalizadas": é pedido do zero/u,
  );
  for (const answer_status of ['unclear', 'other', 'question']) {
    const result = decide(ctx, {
      answer_status,
      external_context: true,
      asked_field: 'colors',
    });
    assert.equal(result.trigger, null, answer_status);
    assert.equal(result.handoff_required, false);
    assert.equal(
      result.briefing_patch.notes,
      'Referência do site: Camisa de e-sports com frente e costas personalizadas; quer algo parecido',
    );
    // News for the ficha: the colour waits and the next point comes.
    assert.equal(result.briefing_patch.briefing_status, 'quote_skipped');
    assert.equal(result.briefing_patch.next_required_field, 'quantity');
    assert.doesNotMatch(
      result.reasoning,
      /não respondeu à mesma pergunta/u,
      answer_status,
    );
  }
});

test('item 3: the reference right after an ignored model question does not hand off as ignored twice', () => {
  // The real order: the model asked, an answer the bot did not read, then the site message.
  const result = decide(
    context(SITE_REFERENCE, {
      briefing: {
        customer_name: 'Rafa',
        product_type: 'camisas',
        next_required_field: 'product_model',
        briefing_status: 'quote_ignored',
      },
    }),
    {
      answer_status: 'other',
      asked_field: 'product_model',
      reply_text: MODEL_QUESTION,
    },
  );
  assert.equal(result.trigger, null);
  assert.equal(result.handoff_required, false);
  // The reference title stays in the notes; the model point waits for the customer's words.
  assert.equal(result.briefing_patch.product_model, undefined);
  assert.equal(result.briefing_patch.briefing_status, 'quote_skipped');
  assert.equal(result.briefing_patch.next_required_field, 'colors');
  assert.match(result.reply_text, /cor/u);
});

test('item 3: the reference tolerates quotes, accents and punctuation, and keeps other notes', () => {
  for (const text of [
    'Vi no site a referencia “Bandeira de torcida” e quero algo parecido',
    'oi! vi no site a referência: Abadá de bloco. Quero algo parecido!',
    'Vi no site a referência Camisa polo bordada e queria algo bem parecido',
  ]) {
    const result = decide(
      context(text, {
        briefing: { ...shirtWithout('colors'), notes: 'Cliente já comprou' },
      }),
      { answer_status: 'other' },
    );
    assert.match(
      result.briefing_patch.notes,
      /^Cliente já comprou \| Referência do site: .+; quer algo parecido$/u,
      text,
    );
    assert.equal(result.trigger, null, text);
  }
});

test('item 3 negatives: the reference with another channel still hands off; a plain message has no reference', () => {
  const external = decide(
    context(`${SITE_REFERENCE} Me manda o orçamento por e-mail`, {
      briefing: shirtWithout('colors'),
    }),
    { answer_status: 'other' },
  );
  assert.equal(external.trigger, 'external_context');

  const plain = decide(
    context('Quero algo parecido com o que vocês fizeram', {
      briefing: shirtWithout('colors'),
    }),
    { answer_status: 'other', briefing_patch: { colors: 'azul' } },
  );
  assert.equal(plain.briefing_patch.notes, undefined);
});

test('item 1: "vcs fazem bandeira?" is acknowledged before the next question, without a yes', () => {
  const result = decide(context('Vcs fazem bandeira?'), {
    reply_text: 'Oi! Eu sou a assistente virtual da Silmer. Qual é o seu nome?',
    asked_field: 'customer_name',
    briefing_patch: { product_type: 'bandeira' },
  });
  assert.equal(result.handoff_required, false);
  assert.match(
    result.reply_text,
    /^Vou anotar para o vendedor confirmar isso\. .*Qual é o seu nome\?$/u,
  );
  assert.ok(sentences(result.reply_text).length <= 3);
  assert.doesNotMatch(result.reply_text, /\b(sim|fazemos)\b/iu);
});

test('item 1: feasibility and fidelity questions are acknowledged; an acknowledged reply is kept', () => {
  for (const text of [
    'vcs conseguem fazer essas camisetas?',
    'o quão fiel à referência fica?',
    'Vocês trabalham com dry fit?',
  ]) {
    const result = decide(context(text), {
      reply_text: 'Que legal! Qual é o seu nome?',
      asked_field: 'customer_name',
    });
    assert.match(
      result.reply_text,
      /^Vou anotar para o vendedor confirmar isso\. Que legal! Qual é o seu nome\?$/u,
      text,
    );
  }
  const already = decide(context('Vocês fazem bandeira?'), {
    reply_text: 'Vou anotar para o vendedor confirmar. Qual é o seu nome?',
    asked_field: 'customer_name',
  });
  assert.equal(
    already.reply_text,
    'Vou anotar para o vendedor confirmar. Qual é o seu nome?',
  );
});

test('item 1 negative: "vocês fazem orçamento?" is not a price question nor a capability question', () => {
  const result = decide(context('Vocês fazem orçamento?'), {
    asks_price: true,
    reply_text: 'Claro! Qual é o seu nome?',
    asked_field: 'customer_name',
  });
  assert.equal(result.trigger, null);
  assert.equal(result.handoff_required, false);
  assert.equal(result.reply_text, 'Claro! Qual é o seu nome?');

  // "Você tem que..." is not a question about what the Silmer does.
  const must = decide(context('Você tem que mandar a arte antes?'), {
    reply_text: 'Qual é o seu nome?',
    asked_field: 'customer_name',
  });
  assert.equal(must.reply_text, 'Qual é o seu nome?');
});

test('item 4: a flag asks its size as the model and its print sides, and has no collar', () => {
  const ctx = context('Quero 10 bandeiras', {
    briefing: { customer_name: 'Rafa', product_type: 'bandeiras' },
  });
  assert.match(ctx.prompt, /Produto: bandeira, faixa ou banner\n/u);
  assert.match(ctx.prompt, /Próximo ponto da ficha: product_model \(modelo\)/u);
  assert.match(
    ctx.prompt,
    /Como perguntar: Qual o tamanho da bandeira\? Por exemplo 1 x 1,5 m, ou me diga onde ela vai ser usada\./u,
  );

  const sides = context('Azul', {
    briefing: {
      customer_name: 'Rafa',
      product_type: 'bandeira',
      product_model: 'bandeira 1 x 1,5 m',
      colors: 'azul',
      quantity: 10,
    },
  });
  assert.match(
    sides.prompt,
    /Como perguntar: Onde vai a estampa: de um lado só ou dos dois lados\?/u,
  );
});

test('item 4: the flag size reaches the Ficha item type through the CRM projection', () => {
  const previous = {
    customer_name: 'Rafa',
    product_type: 'bandeira',
    next_required_field: 'product_model',
    briefing_status: 'quote_collecting',
  };
  const result = decide(context('1 x 1,5 m', { briefing: previous }), {
    answer_status: 'answered',
    asked_field: 'colors',
    briefing_patch: { product_model: '1 x 1,5 m' },
  });
  assert.equal(result.briefing_patch.product_model, 'bandeira 1 x 1,5 m');
  assert.equal(result.briefing_patch.collar, 'NAO APLICAVEL');
  // VND-L02 item 2: the artwork is a point of the flag too.
  assert.equal(result.ficha_total, 8);

  // The field the CRM shows: briefingToFicha makes items[].tipo from
  // product_model (falling back to product_type), so the size is on item 1.
  const ficha = briefingToFicha({ ...previous, ...result.briefing_patch });
  assert.equal(ficha.items.length, 1);
  assert.equal(ficha.items[0].tipo, 'bandeira 1 x 1,5 m');
  assert.equal(ficha.items[0].gola, NOT_APPLICABLE);
  assert.deepEqual(ficha.items[0].grade, []);
});

test('item 4: a flag size the model put in sizes, or only in the text, still goes to product_model', () => {
  const previous = {
    customer_name: 'Rafa',
    product_type: 'bandeira',
    next_required_field: 'product_model',
  };
  const inSizes = decide(context('2 x 3 m', { briefing: previous }), {
    answer_status: 'answered',
    briefing_patch: { sizes: '2 x 3 m' },
  });
  assert.equal(inSizes.briefing_patch.product_model, 'bandeira 2 x 3 m');
  assert.equal('sizes' in inSizes.briefing_patch, false);
  const ficha = briefingToFicha({ ...previous, ...inSizes.briefing_patch });
  assert.equal(ficha.items[0].tipo, 'bandeira 2 x 3 m');
  assert.deepEqual(ficha.items[0].grade, []);

  const inText = decide(context('uns 1,5 x 2 metros', { briefing: previous }), {
    answer_status: 'unclear',
  });
  assert.equal(inText.briefing_patch.product_model, 'bandeira 1,5 x 2 metros');
  assert.equal(inText.briefing_patch.briefing_status, 'quote_collecting');
});

test('item 4 negatives: a bag still hands off and a captain armband is not a flag', () => {
  const bag = decide(context('Quero 20 mochilas'), {
    briefing_patch: { product_type: 'mochilas' },
  });
  assert.equal(bag.trigger, 'unsupported');

  const armband = context('faixas de capitão', {
    briefing: { customer_name: 'Rafa', product_type: 'faixas de capitão' },
  });
  assert.match(armband.prompt, /Produto: outro produto\n/u);
});

test('item 5: the context gives today in São Paulo from the message time', () => {
  const ctx = context(
    'Quarta feira',
    { briefing: shirtWithout('needed_by') },
    { occurred_at: WEDNESDAY_NIGHT },
  );
  assert.match(
    ctx.prompt,
    /Hoje \(horário de Brasília\): quarta-feira, 28\/10\/2026, 20:01\n/u,
  );
  assert.equal(ctx.message_at, WEDNESDAY_NIGHT);
});

test('item 5: the same weekday as today is confirmed once before the ficha is handed off', () => {
  const briefing = {
    ...shirtWithout('needed_by'),
    next_required_field: 'needed_by',
  };
  const asked = decide(
    context('Quarta feira', { briefing }, { occurred_at: WEDNESDAY_NIGHT }),
    {
      answer_status: 'answered',
      reply_text: 'Perfeito, anotei!',
      briefing_patch: { needed_by: 'quarta-feira' },
    },
  );
  assert.equal(
    asked.briefing_patch.needed_by,
    'quarta-feira (04/11/2026, a confirmar)',
  );
  assert.equal(asked.reply_text, 'Seria quarta que vem, dia 04/11?');
  assert.equal(asked.handoff_required, false);
  assert.equal(asked.handoff_ready, false);
  assert.equal(asked.briefing_patch.next_required_field, 'needed_by');
  assert.doesNotMatch(asked.reply_text, /\b(dá|da tempo|consegu)/iu);

  const confirming = { ...briefing, ...asked.briefing_patch };
  const ctx = context(
    'Sim',
    { briefing: confirming },
    { occurred_at: '2026-10-28T23:05:00.000Z' },
  );
  assert.match(ctx.prompt, /Não pergunte a data de novo/u);
  const confirmed = decide(ctx, { answer_status: 'answered' });
  assert.equal(confirmed.briefing_patch.needed_by, 'quarta-feira (04/11/2026)');
  assert.equal(confirmed.trigger, 'briefing_complete');

  // Only once: a second ambiguous answer gets its date, not a second question.
  const again = decide(
    context(
      'quarta',
      { briefing: confirming },
      { occurred_at: '2026-10-28T23:05:00.000Z' },
    ),
    { answer_status: 'answered', briefing_patch: { needed_by: 'quarta' } },
  );
  assert.equal(again.briefing_patch.needed_by, 'quarta (04/11/2026)');
  assert.equal(again.trigger, 'briefing_complete');
});

test('item 5: a span of days gets the date it ends; next week without a day is confirmed', () => {
  const briefing = {
    ...shirtWithout('needed_by'),
    next_required_field: 'needed_by',
  };
  const span = decide(
    context(
      'Dentro de 20 dias',
      { briefing },
      { occurred_at: '2026-10-28T15:00:00.000Z' },
    ),
    {
      answer_status: 'answered',
      briefing_patch: { needed_by: 'dentro de 20 dias' },
    },
  );
  assert.equal(
    span.briefing_patch.needed_by,
    'dentro de 20 dias (até 17/11/2026)',
  );
  assert.equal(span.trigger, 'briefing_complete');

  const friday = decide(
    context('sexta', { briefing }, { occurred_at: WEDNESDAY_NIGHT }),
    { answer_status: 'answered', briefing_patch: { needed_by: 'sexta-feira' } },
  );
  assert.equal(friday.briefing_patch.needed_by, 'sexta-feira (30/10/2026)');

  const nextWeek = decide(
    context(
      'semana que vem',
      { briefing: shirtWithout('needed_by', 'artwork_locations') },
      { occurred_at: WEDNESDAY_NIGHT },
    ),
    {
      answer_status: 'other',
      briefing_patch: { needed_by: 'semana que vem' },
    },
  );
  assert.equal(
    nextWeek.briefing_patch.needed_by,
    'semana que vem (a partir de 02/11/2026, a confirmar)',
  );
  assert.equal(nextWeek.reply_text, 'Seria para qual dia da semana que vem?');
  assert.equal(nextWeek.briefing_patch.next_required_field, 'needed_by');

  // An absolute date is the customer's, untouched.
  const absolute = decide(
    context('20/11', { briefing }, { occurred_at: WEDNESDAY_NIGHT }),
    { answer_status: 'answered', briefing_patch: { needed_by: '20/11' } },
  );
  assert.equal(absolute.briefing_patch.needed_by, '20/11');
});

test('item 7: a customer introduced by a company names the order and hints the seller, without a profile', () => {
  const ctx = context(
    'Oi, sou a Bia, da Acme Promoções e Eventos. Queria 50 camisetas',
    { briefing: {} },
  );
  const result = decide(ctx, {
    reply_text: 'Que legal! Qual modelo você quer?',
    asked_field: 'product_model',
    briefing_patch: {
      customer_name: 'Bia',
      product_type: '50 camisetas',
      quantity: 50,
      purchase_profile: 'empresa',
    },
  });
  assert.equal(result.briefing_patch.order_name, 'Acme Promoções e Eventos');
  assert.equal('purchase_profile' in result.briefing_patch, false);
  assert.equal(result.handoff_required, false);

  // Later, at the handoff, the seller sees the hint.
  const later = decide(
    context('Quanto custa?', {
      // VND-L02 item 1: the price was asked before, so this one hands off.
      briefing: {
        customer_name: 'Bia',
        ...result.briefing_patch,
        briefing_status: 'quote_price_collecting',
      },
      recent_messages: [
        {
          sender_type: 'customer',
          text: 'Oi, sou a Bia, da Acme Promoções e Eventos. Queria 50 camisetas',
        },
        { sender_type: 'ai', text: 'Que legal! Qual modelo você quer?' },
        { sender_type: 'customer', text: 'Quanto custa?' },
      ],
    }),
    { asks_price: true },
  );
  assert.equal(later.trigger, 'price');
  assert.match(
    later.reasoning,
    /Dica: [^.]*Cliente se apresentou pela empresa Acme Promoções e Eventos/u,
  );
});

test('item 7: other introductions; an order name already given and a city are kept apart', () => {
  /** @param {string} text @param {any} [briefing] */
  const orderName = (text, briefing = {}) =>
    decide(context(text, { briefing }), {
      briefing_patch: { product_type: 'camisetas' },
    }).briefing_patch.order_name;
  assert.equal(orderName('Falo pela empresa Beta Brindes'), 'Beta Brindes');
  assert.equal(
    orderName('somos da Escola Gama e queremos camisetas'),
    'Escola Gama',
  );
  assert.equal(
    orderName('sou o Léo, da Agência Delta', { order_name: 'Festa Junina' }),
    undefined,
  );
  assert.equal(orderName('Sou de São Paulo e quero camisetas'), undefined);
  assert.equal(
    orderName('sou a Bia, da acme promoções e eventos'),
    'acme promoções e eventos',
  );
  assert.equal(orderName('sou o Léo, da empresa Delta'), 'Delta');
  assert.equal(orderName('represento a Omega Brindes'), 'Omega Brindes');
  // Coordinator, 28/10/2026: "sou X, da Y" without a business word in Y is a place, not a company:
  // no order name and no company hint.
  for (const text of [
    'sou a Ana, do Rio de Janeiro',
    'sou o Rafa, da Bahia',
    'sou da zona norte',
  ]) {
    assert.equal(orderName(text), undefined, text);
    const handoff = decide(
      context('Quanto custa?', {
        // VND-L02 item 1: the price was asked before, so this one hands off.
        briefing: {
          product_type: 'camisetas',
          briefing_status: 'price_collecting',
        },
        recent_messages: [
          { sender_type: 'customer', text },
          { sender_type: 'customer', text: 'Quanto custa?' },
        ],
      }),
      { asks_price: true },
    );
    assert.equal(handoff.trigger, 'price', text);
    assert.doesNotMatch(handoff.reasoning, /se apresentou pela empresa/u, text);
  }
  // A profile the customer says is kept.
  const resale = decide(context('Sou a Bia, da Acme. É para revenda'), {
    briefing_patch: { product_type: 'camisetas', purchase_profile: 'revenda' },
  });
  assert.equal(resale.briefing_patch.purchase_profile, 'revenda');
});

test('item 9: a transfer outside the opening hours says when a seller answers', () => {
  /** @param {string|undefined} occurred_at */
  const notice = (occurred_at) =>
    decide(
      context(
        'Quanto custa?',
        // VND-L02 item 1: the price was asked before, so this one hands off.
        {
          briefing: {
            ...shirtWithout('colors'),
            briefing_status: 'quote_price_collecting',
          },
        },
        occurred_at ? { occurred_at } : {},
      ),
      { asks_price: true },
    ).reply_text;
  const plain = notice(undefined);
  assert.doesNotMatch(plain, /horário/u);
  // Wednesday 20:01: tomorrow.
  assert.equal(
    notice(WEDNESDAY_NIGHT),
    `${plain} ${AFTER_HOURS} Um vendedor te responde a partir de amanhã às 9h.`,
  );
  // VND-L03: the weekend cases moved from 31/10-02/11 to 07/11-09/11, because
  // Monday 02/11/2026 is Finados, a holiday (n8n-vendedor-l03.test.js).
  // Saturday 13:00: Sunday is closed, so Monday.
  assert.match(
    notice('2026-11-07T16:00:00.000Z'),
    /Um vendedor te responde a partir de segunda-feira às 9h\.$/u,
  );
  // Sunday: Monday is tomorrow.
  assert.match(
    notice('2026-11-08T18:00:00.000Z'),
    /Um vendedor te responde a partir de amanhã às 9h\.$/u,
  );
  // Monday 08:00: before opening, today.
  assert.match(
    notice('2026-11-09T11:00:00.000Z'),
    /Um vendedor te responde a partir de hoje às 9h\.$/u,
  );
  // Friday 19:00: Saturday morning is tomorrow.
  assert.match(
    notice('2026-10-30T22:00:00.000Z'),
    /a partir de amanhã às 9h\.$/u,
  );
  // Inside the hours (Wednesday 10:00) and at the closing edge. VND-L02 item 10: Saturday 11:59
  // is in the last 30 minutes, so the notice says a seller may answer only on Monday.
  assert.equal(notice('2026-10-28T13:00:00.000Z'), plain);
  assert.match(
    notice('2026-11-07T14:59:00.000Z'),
    /Se não der tempo hoje, um vendedor te responde a partir de segunda-feira às 9h\.$/u,
  );
  assert.match(notice('2026-10-28T21:00:00.000Z'), /amanhã às 9h\.$/u);
});

test('item 9: every transfer notice gets the line, and a reply that is not a transfer never does', () => {
  const night = { occurred_at: WEDNESDAY_NIGHT };
  const complete = decide(
    context('20/11', { briefing: shirtWithout('needed_by') }, night),
    { answer_status: 'answered', briefing_patch: { needed_by: '20/11' } },
  );
  assert.equal(complete.trigger, 'briefing_complete');
  assert.match(complete.reply_text, /amanhã às 9h\.$/u);

  const person = decide(context('Quero falar com um atendente', {}, night), {
    person_request: 'generic',
  });
  assert.equal(person.trigger, 'human_requested');
  assert.match(person.reply_text, /amanhã às 9h\.$/u);

  const reply = decide(
    context('Branca', { briefing: shirtWithout('colors', 'quantity') }, night),
    {
      answer_status: 'answered',
      briefing_patch: { colors: 'branca' },
      reply_text: 'Que legal, e quantas peças você precisa?',
      asked_field: 'quantity',
    },
  );
  assert.equal(reply.handoff_required, false);
  assert.equal(reply.reply_text, 'Que legal, e quantas peças você precisa?');

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
        // VND-L03: Sunday 08/11 (Monday 02/11/2026 is Finados).
        occurred_at: '2026-11-08T18:00:00.000Z',
      },
    },
  );
  assert.match(
    media.payload.handoff.notice.text,
    /^Recebi o seu arquivo, obrigada! .* a partir de amanhã às 9h\.$/u,
  );
});
