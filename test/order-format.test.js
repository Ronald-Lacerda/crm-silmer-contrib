import assert from 'node:assert/strict';
import test from 'node:test';

import {
  amountLabel,
  AUDIENCE_OPTIONS,
  audienceLabel,
  dayLabel,
  deliveryDue,
  duplicateSizes,
  duplicateSizeWarning,
  elapsedSince,
  fabLabel,
  formatBrl,
  HANDOFF_REASON_LABELS,
  isDuplicateSize,
  handoffReasonLabel,
  informedQuantity,
  isItemGap,
  isPageGap,
  itemHeading,
  itemPieces,
  itemQuantityLabel,
  itemQuantityWarning,
  joinPt,
  missingFieldLabels,
  missingHeadline,
  nextOrderStep,
  operationalDay,
  ORDER_REVIEW_SECTION,
  orderSteps,
  orderMilestones,
  orderStatusLabel,
  parseBrl,
  PAYMENT_CONDITION_OPTIONS,
  paymentConditionLabel,
  PRINT_LOCKED_REASON,
  quantityWarning,
  sortedGrade,
} from '../apps/edge-web/src/lib/order-format.js';

test('names the two order statuses of ADR 006', () => {
  assert.equal(orderStatusLabel('pendente'), 'Pendente');
  assert.equal(orderStatusLabel('confirmado'), 'Confirmado');
  assert.equal(orderStatusLabel('inexistente'), 'Sem pedido');
  assert.equal(orderStatusLabel(null), 'Sem pedido');
});

test('offers the three payment conditions in the order of the mockup', () => {
  assert.deepEqual(
    PAYMENT_CONDITION_OPTIONS.map((option) => option.value),
    ['pix', 'cartao_credito', 'cartao_debito'],
  );
  assert.deepEqual(
    PAYMENT_CONDITION_OPTIONS.map((option) => option.label),
    ['Pix', 'Cartão de crédito', 'Cartão de débito'],
  );
  assert.equal(paymentConditionLabel('cartao_credito'), 'Cartão de crédito');
  assert.equal(paymentConditionLabel(null), '—');
});

test('labels every reason_code the handoffs table accepts (A03)', () => {
  // The CHECK constraint of migrations 0013, 0025 and 0046; a code without a
  // label would reach the Inbox as a raw identifier.
  for (const code of [
    'automation_failure',
    'partnership',
    'customer_requested_human',
    'price_before_quote',
    'unresolved_blocker',
    'low_confidence',
    'briefing_complete',
    'human_requested',
    'negotiation',
    'complaint',
    'urgency',
    'unsupported',
    'iteration_limit',
  ]) {
    assert.ok(Object.hasOwn(HANDOFF_REASON_LABELS, code), code);
    assert.notEqual(handoffReasonLabel(code), 'Aguardando vendedor', code);
  }
  assert.equal(handoffReasonLabel('price_before_quote'), 'Perguntou o valor');
  assert.equal(handoffReasonLabel('negotiation'), 'Perguntou o valor');
  assert.equal(
    handoffReasonLabel('customer_requested_human'),
    'Pediu um vendedor',
  );
  assert.equal(handoffReasonLabel('human_requested'), 'Pediu um vendedor');
  assert.equal(handoffReasonLabel('briefing_complete'), 'Pré-ficha completa');
  assert.equal(handoffReasonLabel('unresolved_blocker'), 'Dado divergente');
  assert.equal(handoffReasonLabel('low_confidence'), 'Agente sem confiança');
  assert.equal(handoffReasonLabel('complaint'), 'Reclamação');
  assert.equal(handoffReasonLabel('urgency'), 'Urgência');
  assert.equal(handoffReasonLabel('unsupported'), 'Conteúdo não suportado');
  assert.equal(handoffReasonLabel('iteration_limit'), 'Limite de mensagens');
  assert.equal(handoffReasonLabel('automation_failure'), 'Agente falhou');
  assert.equal(handoffReasonLabel('partnership'), 'Parceria ou revenda');
  assert.equal(handoffReasonLabel('inventado'), 'Aguardando vendedor');
});

test('parses the typed amount in Brazilian format into integer cents', () => {
  assert.equal(parseBrl('4.820,00'), 482000);
  assert.equal(parseBrl('4820'), 482000);
  assert.equal(parseBrl('4820,5'), 482050);
  assert.equal(parseBrl(' 150,00 '), 15000);
  assert.equal(parseBrl('1.234.567,89'), 123456789);
});

test('parses subtotal cents exactly at the safe integer boundary', () => {
  assert.equal(parseBrl('90.071.992.547.409,91'), Number.MAX_SAFE_INTEGER);
  assert.equal(parseBrl('90.071.992.547.409,89'), 9007199254740989);
  assert.equal(parseBrl('90.071.992.547.409,92'), null);
});

test('routes subtotal review blockers to the items instead of an independent amount', () => {
  const missingFields = ['sizePricing.group.line', 'paymentCondition'];
  assert.equal(nextOrderStep({ missingFields })?.section, 'items');
  assert.deepEqual(missingFieldLabels(missingFields), [
    'subtotais por tamanho a revisar',
    'forma de pagamento',
  ]);
});

test('refuses malformed amounts in the browser, before the request', () => {
  // PFI-11: the dot-decimal form is a different number, never a guess.
  for (const text of ['4,820.00', 'abc', '', '0', '0,00', '-1', '1,234']) {
    assert.equal(parseBrl(text), null, text);
  }
  assert.equal(parseBrl(null), null);
  assert.equal(parseBrl(4820), null);
});

test('formats cents the same way the seller types them', () => {
  assert.equal(formatBrl(482000), '4.820,00');
  assert.equal(formatBrl(1), '0,01');
  assert.equal(formatBrl(123456789), '1.234.567,89');
  assert.equal(formatBrl(null), '');
  assert.equal(formatBrl(0), '');
});

test('shows the amount with the fixed prefix, or a dash while it is missing', () => {
  assert.equal(amountLabel(118000), 'R$ 1.180,00');
  assert.equal(amountLabel(null), '—');
});

test('names each point missing to generate in plain words (PIT-06)', () => {
  assert.deepEqual(
    missingFieldLabels([
      'items[0].tipo',
      'items[0].cor',
      'items[0].tipo_servico',
      'items[0].malhas',
      'items[1].grade',
      'items[1].gola',
      'artwork',
      'finalAmount',
      'paymentCondition',
    ]),
    [
      'tipo de roupa do item 1',
      'cor do item 1',
      'técnica do item 1',
      'modelo de malha do item 1',
      'tamanhos do item 2',
      'gola do item 2',
      'quem faz a arte',
      'valor final',
      'forma de pagamento',
    ],
  );
  assert.deepEqual(missingFieldLabels(['items']), ['nenhum item']);
  assert.deepEqual(missingFieldLabels([]), []);
  assert.deepEqual(missingFieldLabels(null), []);
  assert.equal(isItemGap('items'), true);
  assert.equal(isItemGap('items[3].gola'), true);
  assert.equal(isItemGap('finalAmount'), false);
});

test('names an unmapped missing field instead of hiding it', () => {
  assert.deepEqual(missingFieldLabels(['summary.futuro']), ['summary.futuro']);
  for (const extra of ['items[0].modelo', 'items[0].estampa']) {
    assert.deepEqual(
      missingFieldLabels([extra]),
      [extra],
      'an extra never blocks, so it has no label of its own',
    );
  }
});

test('summarises what is missing for the Situação column (PLI-05)', () => {
  assert.equal(missingHeadline([]), 'Pronto para confirmar');
  assert.equal(
    missingHeadline(['items', 'finalAmount', 'paymentCondition']),
    'Nenhum item',
  );
  assert.equal(
    missingHeadline(['finalAmount', 'paymentCondition']),
    'Falta valor final e forma de pagamento',
  );
  assert.equal(missingHeadline(['finalAmount']), 'Falta valor final');
  assert.equal(
    missingHeadline(['items[0].cor', 'finalAmount', 'paymentCondition']),
    'Falta cor do item 1, valor final e mais 1 ponto',
  );
  assert.equal(
    missingHeadline([
      'items[0].cor',
      'items[0].gola',
      'finalAmount',
      'paymentCondition',
    ]),
    'Falta cor do item 1, gola do item 1 e mais 2 pontos',
  );
  assert.equal(missingHeadline(null), 'Pronto para confirmar');
});

test('joins parts of a sentence the Portuguese way', () => {
  assert.equal(joinPt([]), '');
  assert.equal(joinPt(['a']), 'a');
  assert.equal(joinPt(['a', 'b']), 'a e b');
  assert.equal(joinPt(['a', 'b', 'c']), 'a, b e c');
});

test('heads each item with its type and the pieces of its sizes (PIT-01)', () => {
  const item = {
    grade: [
      { quantidade: 100, tamanho: 'M' },
      { quantidade: 50, tamanho: 'G' },
    ],
    tipo: 'CAMISETA',
  };
  assert.equal(itemPieces(item), 150);
  assert.equal(itemHeading(item, 0), 'Item 1 · CAMISETA · 150 peças');
  assert.equal(
    itemHeading({ grade: [], tipo: ' ' }, 2),
    'Item 3 · — · 0 peças',
  );
  assert.equal(itemPieces({}), 0);
});

test('compares the sizes with the quantity the customer said, without blocking (PIT-09)', () => {
  /** @param {unknown} quantity @param {number} totalPieces */
  const order = (quantity, totalPieces) => ({
    ficha: { serviceData: quantity === undefined ? {} : { quantity } },
    totalPieces,
  });
  assert.deepEqual(informedQuantity(order(30, 0)), { count: 30, text: '30' });
  assert.deepEqual(informedQuantity(order('30 peças', 0)), {
    count: 30,
    text: '30 peças',
  });
  assert.deepEqual(informedQuantity(order('entre 20 e 30', 0)), {
    count: null,
    text: 'entre 20 e 30',
  });
  assert.equal(informedQuantity(order('Definir com o vendedor', 0)), null);
  assert.equal(informedQuantity(order(undefined, 0)), null);
  assert.equal(informedQuantity(order('', 0)), null);

  assert.equal(
    quantityWarning(order(30, 40)),
    'A soma dos tamanhos (40) é diferente da quantidade informada (30)',
  );
  assert.equal(quantityWarning(order(40, 40)), '');
  assert.equal(quantityWarning(order(30, 0)), '', 'no sizes, no warning');
  assert.equal(quantityWarning(order('uns 30 ou 40', 20)), '');
  assert.equal(quantityWarning(order(undefined, 20)), '');

  const empty = { grade: [] };
  assert.equal(
    itemQuantityLabel(empty, 0, order(30, 0)),
    '— (cliente informou 30)',
  );
  assert.equal(itemQuantityLabel(empty, 1, order(30, 0)), '—');
  assert.equal(itemQuantityLabel(empty, 0, order(undefined, 0)), '—');
  assert.equal(
    itemQuantityLabel(
      { grade: [{ quantidade: 1, tamanho: 'M' }] },
      0,
      order(30, 1),
    ),
    '1 peça',
  );
});

test('measures how long the order has been still (A02)', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');
  assert.equal(elapsedSince('2026-09-12T11:59:30.000Z', now), 'agora');
  assert.equal(elapsedSince('2026-09-12T11:57:00.000Z', now), '3min');
  assert.equal(elapsedSince('2026-09-12T09:46:00.000Z', now), '2h 14min');
  assert.equal(elapsedSince('2026-09-12T06:58:00.000Z', now), '5h 02min');
  assert.equal(elapsedSince('2026-09-11T08:45:00.000Z', now), '1d 03h');
  assert.equal(elapsedSince('2026-09-12T12:30:00.000Z', now), 'agora');
  assert.equal(elapsedSince('', now), '');
  assert.equal(elapsedSince('not a date', now), '');
});

test('states why printing is locked while the order is pending (PIM-01)', () => {
  assert.equal(PRINT_LOCKED_REASON, 'Disponível depois de gerar o pedido');
});

test('prints the FAB the same way whether the code carries the prefix or not', () => {
  assert.equal(fabLabel('01'), 'FAB 01');
  assert.equal(fabLabel('FAB 01'), 'FAB 01');
  assert.equal(fabLabel('fab 02'), 'FAB 02');
  assert.equal(fabLabel('FABRICA'), 'FAB FABRICA');
  assert.equal(fabLabel(''), '—');
  assert.equal(fabLabel(null), '—');
});

test('reads days the way the operation does, on São Paulo time', () => {
  assert.equal(dayLabel('2026-10-24'), '24/10/2026');
  assert.equal(dayLabel('30/09/2026'), '30/09/2026', 'older free text stays');
  assert.equal(dayLabel(null), '');
  // 01:30 UTC on 13/09 is still 12/09 in São Paulo.
  assert.equal(operationalDay('2026-09-13T01:30:00.000Z'), '2026-09-12');
  assert.equal(
    operationalDay(new Date('2026-09-13T03:00:00.000Z')),
    '2026-09-13',
  );
  assert.equal(operationalDay('not a date'), '');
  assert.equal(operationalDay(null), '');
});

test('shows each business date once across summary and trail (PLA-01..03, PLA-08)', () => {
  const order = {
    deliveredOn: null,
    ficha: { summary: { data_entrega_confirmada: '2026-10-24' } },
    firstContactAt: '2026-09-02T01:30:00.000Z',
    orderDate: '2026-09-09',
    paidOn: '2026-09-10',
  };
  assert.deepEqual(orderMilestones(order), [
    {
      key: 'firstContact',
      label: 'Primeiro contato',
      note: 'vem da conversa',
      recorded: true,
      value: '01/09/2026',
    },
    {
      key: 'paid',
      label: 'Pago em',
      note: 'informado',
      recorded: true,
      value: '10/09/2026',
    },
    {
      key: 'delivered',
      label: 'Entregue em',
      note: 'a informar',
      recorded: false,
      value: '—',
    },
  ]);
  assert.deepEqual(
    orderMilestones({ ficha: { summary: {} } }).map((step) => [
      step.value,
      step.note,
    ]),
    [
      ['—', 'sem registro'],
      ['—', 'a informar'],
      ['—', 'a informar'],
    ],
  );
  assert.equal(orderMilestones(order).length, 3);
  assert.ok(
    orderMilestones(order).every(
      (step) => !['closed', 'promised'].includes(step.key),
    ),
  );
});

test('names the promised delivery and tells it apart from the amount and payment method', () => {
  assert.deepEqual(
    missingFieldLabels([
      'items[0].cor',
      'summary.data_entrega_confirmada',
      'finalAmount',
      'paymentCondition',
    ]),
    ['cor do item 1', 'entrega prometida', 'valor final', 'forma de pagamento'],
  );
  assert.equal(isPageGap('summary.data_entrega_confirmada'), true);
  assert.equal(isPageGap('items[0].cor'), true);
  assert.equal(isPageGap('finalAmount'), false);
  assert.equal(isPageGap('paymentCondition'), false);
  assert.equal(
    missingHeadline(['summary.data_entrega_confirmada']),
    'Falta entrega prometida',
  );
});

/** @param {ReturnType<typeof orderSteps>} steps */
function stepStates(steps) {
  return steps.map(({ done, key, missing }) => ({ done, key, missing }));
}

test('derives the three steps to generate from missingFields only (PFI-15)', () => {
  const order = {
    missingFields: [
      'items[0].cor',
      'artwork',
      'summary.data_entrega_confirmada',
      'finalAmount',
      'paymentCondition',
    ],
    status: 'pendente',
  };
  const steps = orderSteps(order);
  assert.deepEqual(
    steps.map(({ action, key, label, section }) => ({
      action,
      key,
      label,
      section,
    })),
    [
      {
        action: 'Informar entrega prometida',
        key: 'delivery',
        label: 'Entrega prometida',
        section: 'summary',
      },
      {
        action: 'Completar itens',
        key: 'items',
        label: 'Itens',
        section: 'items',
      },
      {
        action: 'Marcar quem faz a arte',
        key: 'artwork',
        label: 'Arte do pedido',
        section: 'artwork',
      },
    ],
  );
  assert.deepEqual(stepStates(steps), [
    { done: false, key: 'delivery', missing: 'falta: a data combinada' },
    { done: false, key: 'items', missing: 'falta: cor do item 1' },
    { done: false, key: 'artwork', missing: 'falta: quem faz a arte' },
  ]);
  assert.equal(nextOrderStep(order)?.key, 'delivery');

  // The amount and the payment method are not steps: with only them left,
  // every step is done and there is no next one.
  const ready = { missingFields: ['finalAmount', 'paymentCondition'] };
  assert.deepEqual(
    orderSteps(ready).map((step) => step.done),
    [true, true, true],
  );
  assert.equal(nextOrderStep(ready), null);
  assert.equal(nextOrderStep({ missingFields: [] }), null);
});

test('names what an item step lacks without inventing progress (PFI-15)', () => {
  // An item without colour: only the items step is missing.
  const noColour = { missingFields: ['items[1].cor'] };
  assert.deepEqual(stepStates(orderSteps(noColour)), [
    { done: true, key: 'delivery', missing: '' },
    { done: false, key: 'items', missing: 'falta: cor do item 2' },
    { done: true, key: 'artwork', missing: '' },
  ]);
  assert.equal(nextOrderStep(noColour)?.action, 'Completar itens');

  // No item at all.
  assert.equal(
    orderSteps({ missingFields: ['items'] })[1].missing,
    'falta: ao menos um item',
  );

  // PIT-04: an order recorded before ADR 016 reads with colour, technique and
  // collar blank; the step counts them as missing, two by name and the rest.
  const older = {
    missingFields: [
      'items[0].cor',
      'items[0].tipo_servico',
      'items[0].gola',
      'finalAmount',
      'paymentCondition',
    ],
  };
  assert.equal(
    orderSteps(older)[1].missing,
    'falta: cor do item 1, técnica do item 1 e mais 1 ponto',
  );
  assert.equal(nextOrderStep(older)?.key, 'items');
});

test('has no steps for a store order or an order without the list (PFI-15, LOJ-34)', () => {
  assert.deepEqual(
    orderSteps({ missingFields: ['artwork'], origin: 'loja' }),
    [],
  );
  assert.equal(nextOrderStep({ missingFields: [], origin: 'loja' }), null);
  assert.deepEqual(orderSteps({}), []);
  assert.deepEqual(orderSteps(null), []);
  assert.equal(nextOrderStep(undefined), null);
});

test('turns a blocker the screen does not know into "Revisar pendências", never a false 3 de 3 (PFI-15)', () => {
  // A key newer than this screen, with the three steps done: four steps, the
  // last one pending and naming the key as the server sent it.
  const newer = {
    missingFields: ['summary.futuro', 'finalAmount', 'paymentCondition'],
  };
  const steps = orderSteps(newer);
  assert.equal(steps.length, 4);
  assert.deepEqual(stepStates(steps), [
    { done: true, key: 'delivery', missing: '' },
    { done: true, key: 'items', missing: '' },
    { done: true, key: 'artwork', missing: '' },
    { done: false, key: 'review', missing: 'falta: summary.futuro' },
  ]);
  const next = nextOrderStep(newer);
  assert.equal(next?.key, 'review');
  assert.equal(next?.label, 'Outras pendências');
  assert.equal(next?.action, 'Revisar pendências');
  // No section fills it: the step leads to the closing panel.
  assert.equal(next?.section, ORDER_REVIEW_SECTION);
  assert.equal(ORDER_REVIEW_SECTION, 'closing');
  assert.notEqual(
    steps.filter((step) => step.done).length,
    steps.length,
    'the count never reads as complete while the server lists a blocker',
  );

  // Alongside known gaps it comes last, after the steps of the page, and a
  // known label is used when the screen has one.
  const mixed = {
    missingFields: [
      'cliente.documento',
      'artwork',
      'items[0].cor',
      'summary.futuro',
      'items[2].novo_ponto',
      'paymentCondition',
    ],
  };
  assert.deepEqual(
    orderSteps(mixed).map((step) => step.key),
    ['delivery', 'items', 'artwork', 'review'],
  );
  assert.equal(nextOrderStep(mixed)?.key, 'items');
  assert.equal(
    orderSteps(mixed)[1].missing,
    'falta: cor do item 1 e items[2].novo_ponto',
  );
  assert.equal(
    orderSteps(mixed)[3].missing,
    'falta: cliente.documento e summary.futuro',
  );

  // Many unknown keys: two by name and the rest counted.
  assert.equal(
    orderSteps({ missingFields: ['a.um', 'b.dois', 'c.tres', 'd.quatro'] })[3]
      .missing,
    'falta: a.um, b.dois e mais 2 pontos',
  );

  // The amount and the payment method are never a step, known or not.
  assert.equal(
    orderSteps({ missingFields: ['finalAmount', 'paymentCondition'] }).length,
    3,
  );
  // A store order still has no steps at all.
  assert.deepEqual(
    orderSteps({ missingFields: ['summary.futuro'], origin: 'loja' }),
    [],
  );
});

test('an item says its audience and compares its sizes with the quantity said for it (ADR 025)', () => {
  assert.deepEqual(
    AUDIENCE_OPTIONS.map((option) => option.value),
    ['masculino', 'feminino', 'infantil', 'unissex'],
  );
  assert.equal(audienceLabel('infantil'), 'Infantil');
  assert.equal(audienceLabel(''), '');
  assert.equal(audienceLabel('baby look'), '');

  const feminine = {
    grade: [{ quantidade: 8, tamanho: 'M' }],
    publico: 'feminino',
    quantidade_informada: 10,
    tipo: 'CAMISETA',
  };
  assert.equal(
    itemHeading(feminine, 1),
    'Item 2 · CAMISETA · Feminino · 8 peças',
  );
  assert.equal(
    itemQuantityWarning(feminine),
    'A soma dos tamanhos (8) é diferente da quantidade informada (10)',
  );
  assert.equal(
    itemQuantityWarning({ ...feminine, quantidade_informada: 8 }),
    '',
  );
  assert.equal(itemQuantityWarning({ ...feminine, grade: [] }), '');
  assert.equal(
    itemQuantityWarning({ ...feminine, quantidade_informada: null }),
    '',
  );

  /** @type {any} */
  const order = { ficha: { serviceData: { quantity: 25 } }, totalPieces: 0 };
  assert.equal(
    itemQuantityLabel({ grade: [], quantidade_informada: 10 }, 1, order),
    '— (cliente informou 10)',
    'any item shows the quantity said for it',
  );
  assert.equal(
    itemQuantityLabel({ grade: [], quantidade_informada: 4 }, 0, order),
    '— (cliente informou 4)',
    'the item quantity comes before the order quantity',
  );
});

// Pesquisa UX 2026-10-15, achado 3: the "Entrega" column of Pedidos.
test('reads the promised delivery against today on São Paulo days', () => {
  // 15/10/2026 at 23:30 in São Paulo is already the 16th in UTC.
  const now = new Date('2026-10-16T02:30:00.000Z');
  /** @param {string|null} day @param {string|null} [deliveredOn] */
  const order = (day, deliveredOn = null) => ({
    deliveredOn,
    ficha: { summary: { data_entrega_confirmada: day } },
  });
  assert.deepEqual(deliveryDue(order('2026-10-24'), now), {
    date: '24/10',
    days: 9,
    overdue: false,
    relative: 'em 9 dias',
    tone: '',
  });
  assert.equal(deliveryDue(order('2026-10-20'), now).tone, 'info');
  assert.equal(deliveryDue(order('2026-10-16'), now).relative, 'Amanhã');
  assert.equal(deliveryDue(order('2026-10-15'), now).relative, 'Entrega hoje');
  const late = deliveryDue(order('2026-10-13'), now);
  assert.equal(late.relative, 'Atrasada há 2 dias');
  assert.equal(late.tone, 'error');
  assert.equal(late.overdue, true);
  assert.equal(
    deliveryDue(order('2026-10-14'), now).relative,
    'Atrasada há 1 dia',
  );
  assert.deepEqual(deliveryDue(order('2026-10-13', '2026-10-12'), now), {
    date: '13/10',
    days: null,
    overdue: false,
    relative: 'Entregue em 12/10',
    tone: 'success',
  });
  assert.equal(deliveryDue(order(null), now).date, 'Sem data');
  assert.equal(
    deliveryDue(order('fim de outubro'), now).date,
    'fim de outubro',
  );
  assert.equal(deliveryDue(order('fim de outubro'), now).days, null);
});

// Pesquisa UX 2026-10-15, achado 4: the size grade as the floor counts it.
test('sorts a grade in canonical size order and keeps unknown sizes last', () => {
  const grade = [
    { quantidade: 5, tamanho: 'GG' },
    { quantidade: 3, tamanho: 'Baby look' },
    { quantidade: 10, tamanho: 'm' },
    { quantidade: 2, tamanho: '12' },
    { quantidade: 4, tamanho: 'PP' },
    { quantidade: 1, tamanho: 'JEGÃO' },
    { quantidade: 6, tamanho: '3–6 meses' },
    { quantidade: 7, tamanho: '4' },
    { quantidade: 8, tamanho: 'XG' },
    { quantidade: 9, tamanho: 'EG' },
  ];
  assert.deepEqual(
    sortedGrade(grade).map((line) => line.tamanho),
    ['3–6 meses', '4', '12', 'PP', 'm', 'GG', 'EG', 'XG', 'JEGÃO', 'Baby look'],
  );
  assert.deepEqual(
    sortedGrade(grade).map((line) => line.index),
    [6, 7, 3, 4, 2, 0, 9, 8, 5, 1],
    'each line keeps its index in the ficha',
  );
  assert.deepEqual(sortedGrade(undefined), []);
});

test('flags a size written on more than one line of the same item', () => {
  const grade = [
    { quantidade: 10, tamanho: 'M' },
    { quantidade: 5, tamanho: 'G' },
    { quantidade: 3, tamanho: ' m ' },
  ];
  assert.deepEqual(duplicateSizes(grade), ['M']);
  assert.equal(isDuplicateSize(grade, 'm'), true);
  assert.equal(isDuplicateSize(grade, 'G'), false);
  assert.equal(
    duplicateSizeWarning(grade),
    'O tamanho M aparece em mais de uma linha. Junte as quantidades numa linha só.',
  );
  assert.equal(
    duplicateSizeWarning([...grade, { quantidade: 1, tamanho: 'G' }]),
    'Os tamanhos M e G aparecem em mais de uma linha. Junte as quantidades de cada um numa linha só.',
  );
  assert.equal(
    duplicateSizeWarning([
      { quantidade: 1, tamanho: '' },
      { quantidade: 1, tamanho: '' },
    ]),
    '',
  );
  assert.equal(duplicateSizeWarning(null), '');
});
