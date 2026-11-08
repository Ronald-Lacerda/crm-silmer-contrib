import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assistantIndicator,
  attendanceRows,
  compactReais,
  dailySalesChart,
  dueSoonIndicator,
  elapsedLabel,
  longDay,
  mineIndicator,
  myOrdersIndicator,
  nextStep,
  overdueIndicator,
  pendingIndicator,
  replyIndicator,
  shortDay,
  shortPersonName,
  soldIndicator,
  unavailableIndicator,
  waitingIndicator,
} from '../apps/edge-web/src/lib/dashboard-format.js';

const NOW = '2026-10-15T15:00:00.000Z';

test('Painel: elapsed time is read between two server instants', () => {
  assert.equal(elapsedLabel('2026-10-15T14:59:30.000Z', NOW), 'agora');
  assert.equal(elapsedLabel('2026-10-15T14:35:00.000Z', NOW), 'há 25 min');
  assert.equal(elapsedLabel('2026-10-15T12:00:00.000Z', NOW), 'há 3 h');
  assert.equal(elapsedLabel('2026-10-14T14:00:00.000Z', NOW), 'há 1 dia');
  assert.equal(elapsedLabel('2026-10-12T15:00:00.000Z', NOW), 'há 3 dias');
  // A future instant (clock skew) never reads as negative.
  assert.equal(elapsedLabel('2026-10-15T15:05:00.000Z', NOW), 'agora');
  assert.equal(elapsedLabel(null, NOW), '');
  assert.equal(elapsedLabel('x', NOW), '');
});

test('Painel: days read as the operation writes them', () => {
  assert.equal(shortDay('2026-10-09'), '09/10');
  assert.equal(shortDay(null), '');
  assert.equal(longDay('2026-10-15'), 'Quinta-feira, 15 de outubro');
  assert.equal(longDay('15/10/2026'), '');
});

test('Painel: my queue says who waits for my answer', () => {
  assert.deepEqual(mineIndicator(undefined, NOW), {
    badge: '',
    detail: 'Nenhuma conversa com você agora',
    tone: null,
    value: '0',
  });
  assert.equal(
    mineIndicator({ awaitingReplyCount: 0, count: 2 }, NOW).detail,
    'Nenhum cliente esperando sua resposta',
  );
  const waiting = mineIndicator(
    {
      awaitingReplyCount: 2,
      count: 3,
      oldestAwaitingSince: '2026-10-15T14:20:00.000Z',
    },
    NOW,
  );
  assert.equal(waiting.value, '3');
  assert.equal(waiting.tone, 'warning');
  assert.equal(
    waiting.detail,
    '2 clientes esperam sua resposta; o primeiro escreveu há 40 min',
  );
});

test('Painel: the seller home says what to answer now and their own orders', () => {
  assert.deepEqual(
    replyIndicator(
      {
        awaitingReplyCount: 2,
        count: 3,
        oldestAwaitingSince: '2026-10-15T14:35:00.000Z',
      },
      NOW,
    ),
    {
      badge: '',
      detail: 'O primeiro cliente escreveu há 25 min',
      tone: 'warning',
      value: '2',
    },
  );
  assert.equal(
    replyIndicator({ awaitingReplyCount: 0, count: 3 }, NOW).detail,
    'Ninguém esperando; 3 conversas suas em andamento',
  );
  assert.equal(replyIndicator(undefined, NOW).value, '0');
  assert.equal(myOrdersIndicator(2).value, '2');
  assert.equal(
    myOrdersIndicator(undefined).detail,
    'Nenhum pedido seu esperando confirmação',
  );
});

test('Painel: handoffs past the server SLA are an error with a text badge', () => {
  assert.equal(waitingIndicator({ count: 0 }, NOW).tone, null);
  const onTime = waitingIndicator(
    { count: 1, oldestSince: '2026-10-15T14:50:00.000Z', overdueCount: 0 },
    NOW,
  );
  assert.equal(onTime.tone, 'warning');
  assert.equal(onTime.badge, '');
  assert.equal(onTime.detail, 'A mais antiga está parada há 10 min');
  const late = waitingIndicator(
    { count: 3, oldestSince: '2026-10-15T09:00:00.000Z', overdueCount: 2 },
    NOW,
  );
  assert.equal(late.tone, 'error');
  assert.equal(late.badge, '2 fora do prazo');
  assert.equal(late.detail, 'A mais antiga está parada há 6 h');
});

test('Painel: the assistant reports trouble before activity', () => {
  assert.deepEqual(
    assistantIndicator(
      {
        activeCount: 4,
        failedDeliveryCount: 1,
        lastReplyAt: '2026-10-15T14:58:00.000Z',
        stallMinutes: 10,
        stalledCount: 2,
      },
      NOW,
    ),
    {
      badge: 'Atenção',
      detail: '2 sem resposta há 10 min ou mais; 1 com envio falho em 24 h',
      tone: 'warning',
      value: 'Pede atenção',
    },
  );
  const healthy = assistantIndicator(
    { activeCount: 1, lastReplyAt: '2026-10-15T14:57:00.000Z' },
    NOW,
  );
  assert.equal(healthy.value, 'Respondendo');
  assert.equal(healthy.tone, 'success');
  assert.equal(
    healthy.detail,
    '1 conversa com o assistente; última resposta há 3 min',
  );
  assert.equal(
    assistantIndicator({ lastReplyAt: '2026-10-15T13:00:00.000Z' }, NOW).detail,
    'Última resposta há 2 h',
  );
  assert.deepEqual(assistantIndicator(undefined, NOW), {
    badge: '',
    detail: 'Nenhuma resposta nas últimas 24 h',
    tone: null,
    value: 'Sem conversas agora',
  });
});

test('Painel: sales, pending orders and deliveries tolerate a missing field', () => {
  const sold = soldIndicator({ confirmedCount: 2, soldAmountCents: 250000 });
  assert.equal(sold.value.replace(/\s/gu, ' '), 'R$ 2.500,00');
  assert.match(sold.detail, /^2 pedidos confirmados; ticket médio R\$/u);
  assert.equal(
    soldIndicator(undefined).detail,
    'Nenhum pedido confirmado no período',
  );
  assert.equal(pendingIndicator(1).value, '1');
  assert.equal(pendingIndicator(undefined).value, '0');
  assert.deepEqual(
    overdueIndicator({ oldestOverdueOn: '2026-10-09', overdueCount: 2 }),
    {
      badge: '',
      detail: 'A mais antiga era para 09/10',
      tone: 'error',
      value: '2',
    },
  );
  assert.equal(overdueIndicator(undefined).tone, null);
  assert.equal(
    dueSoonIndicator({ dueSoonCount: 3, dueSoonUntil: '2026-10-21' }).detail,
    'Previstas de hoje até 21/10',
  );
});

// PNL-01 e PNL-03 (RFC 024, proposta D): one next step per role, first rule
// with something pending wins; the queue rules are skipped while it fails.
const CALM_QUEUE = Object.freeze({
  assistant: { activeCount: 2, failedDeliveryCount: 0, stalledCount: 0 },
  mine: { awaitingReplyCount: 0, count: 1, pendingOrderCount: 0 },
  waitingHandoff: { count: 0, overdueCount: 0 },
});
const CALM_SUMMARY = Object.freeze({
  deliveries: { overdueCount: 0 },
  pendingCount: 0,
});

/**
 * @param {Record<string, any>} base
 * @param {Record<string, any>} changes
 */
function withChanges(base, changes) {
  /** @type {Record<string, any>} */
  const copy = structuredClone(base);
  for (const [group, values] of Object.entries(changes)) {
    copy[group] =
      values && typeof values === 'object'
        ? { ...copy[group], ...values }
        : values;
  }
  return copy;
}

/**
 * @param {boolean} isManager
 * @param {{queue?: Record<string, any>, summary?: Record<string, any>, queueError?: string}} [changes]
 */
function stepFor(
  isManager,
  { queue = {}, summary = {}, queueError = '' } = {},
) {
  return nextStep({
    isManager,
    queue: withChanges(CALM_QUEUE, queue),
    queueError,
    summary: withChanges(CALM_SUMMARY, summary),
  });
}

test('Painel: the seller next step follows the priority of the queue', () => {
  const all = {
    queue: {
      mine: { awaitingReplyCount: 3, pendingOrderCount: 2 },
      waitingHandoff: { count: 4 },
    },
    summary: { deliveries: { overdueCount: 2 } },
  };
  assert.deepEqual(stepFor(false, all), {
    key: 'reply',
    label: 'Responder 3 conversas',
    action: 'Ver conversas',
    to: { path: '/inbox', query: { fila: 'minhas' } },
  });
  assert.equal(
    stepFor(false, { queue: { mine: { awaitingReplyCount: 1 } } }).label,
    'Responder 1 conversa',
  );

  const takeOver = stepFor(false, {
    queue: { mine: { pendingOrderCount: 2 }, waitingHandoff: { count: 4 } },
    summary: { deliveries: { overdueCount: 2 } },
  });
  assert.equal(takeOver.label, 'Assumir 4 conversas em espera');
  assert.deepEqual(takeOver.to, {
    path: '/inbox',
    query: { situacao: 'aguardando' },
  });

  const myPending = stepFor(false, {
    queue: { mine: { pendingOrderCount: 1 } },
    summary: { deliveries: { overdueCount: 2 } },
  });
  assert.equal(myPending.label, 'Completar 1 pedido pendente');
  assert.deepEqual(myPending.to, {
    path: '/pedidos',
    query: { status: 'pendente', vendedor: 'eu' },
  });

  const late = stepFor(false, { summary: { deliveries: { overdueCount: 2 } } });
  assert.equal(late.label, 'Conferir 2 entregas atrasadas');
  assert.deepEqual(late.to, {
    path: '/pedidos',
    query: { entrega: 'atrasada' },
  });

  // Store orders have their own notice; the manager's pending orders and the
  // assistant are not the seller's next step.
  assert.deepEqual(
    stepFor(false, {
      queue: { assistant: { stalledCount: 3 } },
      summary: { pendingCount: 5, storeNewCount: 2 },
    }),
    { key: 'calm', label: 'Nada urgente agora.', action: '', to: null },
  );
});

test('Painel: the manager next step starts from the SLA', () => {
  const all = {
    queue: {
      assistant: { failedDeliveryCount: 1, stalledCount: 1 },
      mine: { awaitingReplyCount: 5 },
      waitingHandoff: { count: 3, overdueCount: 2 },
    },
    summary: { deliveries: { overdueCount: 1 }, pendingCount: 6 },
  };
  assert.deepEqual(stepFor(true, all), {
    key: 'out-of-sla',
    label: 'Atender 2 conversas fora do prazo',
    action: 'Ver conversas',
    to: { path: '/inbox', query: { situacao: 'aguardando' } },
  });

  const late = stepFor(true, {
    queue: { assistant: { stalledCount: 1 }, waitingHandoff: { count: 3 } },
    summary: { deliveries: { overdueCount: 1 }, pendingCount: 6 },
  });
  assert.equal(late.label, 'Conferir 1 entrega atrasada');

  for (const assistant of [{ stalledCount: 1 }, { failedDeliveryCount: 2 }]) {
    const step = stepFor(true, {
      queue: { assistant },
      summary: { pendingCount: 6 },
    });
    assert.equal(step.label, 'Verificar as conversas do assistente');
    assert.deepEqual(step.to, {
      path: '/inbox',
      query: { situacao: 'agente' },
    });
  }

  const pending = stepFor(true, { summary: { pendingCount: 6 } });
  assert.equal(pending.label, 'Confirmar 6 pedidos pendentes');
  assert.deepEqual(pending.to, {
    path: '/pedidos',
    query: { status: 'pendente' },
  });

  // Waiting within the SLA and the manager's own conversations are not it.
  assert.equal(
    stepFor(true, {
      queue: {
        mine: { awaitingReplyCount: 4 },
        waitingHandoff: { count: 2 },
      },
    }).label,
    'Nada urgente agora.',
  );
});

test('Painel: with the queue failing, the next step invents nothing', () => {
  const busyQueue = {
    assistant: { stalledCount: 2 },
    mine: { awaitingReplyCount: 3, pendingOrderCount: 2 },
    waitingHandoff: { count: 4, overdueCount: 2 },
  };
  const queueError = 'Não foi possível consultar a fila agora.';
  // Stale numbers of an earlier read are skipped as well.
  assert.equal(
    stepFor(false, {
      queue: busyQueue,
      queueError,
      summary: { deliveries: { overdueCount: 2 } },
    }).label,
    'Conferir 2 entregas atrasadas',
  );
  assert.equal(
    stepFor(true, {
      queue: busyQueue,
      queueError,
      summary: { pendingCount: 3 },
    }).label,
    'Confirmar 3 pedidos pendentes',
  );
  for (const isManager of [false, true]) {
    assert.deepEqual(stepFor(isManager, { queue: busyQueue, queueError }), {
      key: 'queue-unavailable',
      label: 'A fila não respondeu; tente de novo mais abaixo.',
      action: '',
      to: null,
    });
    assert.equal(
      nextStep({ isManager, queue: null, queueError: '', summary: {} }).key,
      'queue-unavailable',
    );
  }
  assert.deepEqual(unavailableIndicator(), {
    badge: '',
    detail: 'Sem dados da fila agora',
    tone: null,
    value: '—',
  });
});

test('Painel: no next step link is named like an indicator', () => {
  const steps = [false, true].flatMap((isManager) =>
    [
      { queue: { mine: { awaitingReplyCount: 2 } } },
      { queue: { waitingHandoff: { count: 2, overdueCount: 1 } } },
      { queue: { mine: { pendingOrderCount: 2 } } },
      { queue: { assistant: { stalledCount: 1 } } },
      { summary: { deliveries: { overdueCount: 2 }, pendingCount: 2 } },
      { summary: { pendingCount: 2 } },
    ].map((changes) => stepFor(isManager, changes)),
  );
  for (const step of steps) {
    assert.doesNotMatch(
      step.label,
      /^(Vendido|Minhas conversas|Responder agora|Esperando vendedor|Assistente|Entregas atrasadas|Meus pedidos pendentes|Pedidos a confirmar)/u,
    );
  }
});

// PNL-05 / PNL-06 (pedido do PO de 06/11/2026, PNL-T05).
const UNANSWERED = Object.freeze({
  thresholdMinutes: 15,
  count: 7,
  bySeller: [
    { userId: 'seller-b', name: 'Bruno Teixeira', count: 3 },
    { userId: 'seller-p', name: 'Pedro Martins', count: 1 },
    { userId: 'seller-a', name: 'Ana', count: 1 },
    { userId: 'seller-c', name: 'Carla Souza Lima', count: 1 },
    { userId: 'seller-d', name: 'Davi Rocha', count: 1 },
  ],
});

test('Painel: a person reads as first name and initial', () => {
  assert.equal(shortPersonName('Bruno Teixeira'), 'Bruno T.');
  assert.equal(shortPersonName('  Carla  Souza da lima '), 'Carla L.');
  assert.equal(shortPersonName('Ana'), 'Ana');
  assert.equal(shortPersonName(''), '');
  assert.equal(shortPersonName(null), '');
});

test('Painel: bar values are compact reais', () => {
  assert.equal(compactReais(412_000), '4,1 mil');
  assert.equal(compactReais(200_000), '2 mil');
  assert.equal(compactReais(570_000), '5,7 mil');
  assert.equal(compactReais(85_000), '850');
  assert.equal(compactReais(85_049), '850');
  assert.equal(compactReais(99_960), '1 mil');
  assert.equal(compactReais(1_234_500), '12,3 mil');
  assert.equal(compactReais(123_456_789), '1,2 mi');
  assert.equal(compactReais(0), '0');
  assert.equal(compactReais(undefined), '0');
  assert.equal(compactReais(-500), '0');
});

const WEEK = Object.freeze([
  { day: '2026-10-09', confirmedCount: 10, soldAmountCents: 412_000 },
  { day: '2026-10-10', confirmedCount: 6, soldAmountCents: 200_000 },
  { day: '2026-10-11', confirmedCount: 2, soldAmountCents: 85_000 },
  { day: '2026-10-12', confirmedCount: 14, soldAmountCents: 570_000 },
  { day: '2026-10-13', confirmedCount: 18, soldAmountCents: 650_000 },
  { day: '2026-10-14', confirmedCount: 16, soldAmountCents: 720_000 },
  { day: '2026-10-15', confirmedCount: 12, soldAmountCents: 487_000 },
]);

test('Painel: the week by day labels each day and speaks every value', () => {
  const chart = dailySalesChart(WEEK);
  assert.equal(chart.available, true);
  const plain = (/** @type {string} */ text) => text.replace(/\s/gu, ' ');
  assert.equal(
    plain(chart.summary),
    'Últimos 7 dias · R$ 31.240,00 em 78 pedidos',
  );
  assert.deepEqual(
    chart.bars.map((bar) => bar.label),
    ['Sex', 'Sáb', 'Dom', 'Seg', 'Ter', 'Qua', 'Hoje'],
  );
  assert.deepEqual(
    chart.bars.map((bar) => bar.value),
    ['4,1 mil', '2 mil', '850', '5,7 mil', '6,5 mil', '7,2 mil', '4,9 mil'],
  );
  assert.deepEqual(
    chart.bars.map((bar) => bar.current),
    [false, false, false, false, false, false, true],
  );
  assert.equal(chart.bars[5].ratio, 1);
  assert.equal(chart.bars[0].ratio, 412_000 / 720_000);
  assert.equal(
    plain(chart.description),
    'Vendido por dia: sexta R$ 4.120,00, sábado R$ 2.000,00, domingo R$ 850,00, segunda R$ 5.700,00, terça R$ 6.500,00, quarta R$ 7.200,00, hoje R$ 4.870,00',
  );
});

test('Painel: a week without sales is a flat baseline, a failed read has no bars', () => {
  const zero = dailySalesChart(
    WEEK.map((day) => ({ ...day, confirmedCount: 0, soldAmountCents: 0 })),
  );
  assert.equal(zero.available, true);
  assert.deepEqual(
    zero.bars.map((bar) => bar.ratio),
    [0, 0, 0, 0, 0, 0, 0],
  );
  assert.equal(zero.bars[6].value, '0');
  assert.match(zero.summary, /em 0 pedidos$/u);
  // One small sale still leaves a sliver above the baseline.
  const tiny = dailySalesChart([
    { day: '2026-10-14', confirmedCount: 1, soldAmountCents: 1_000_000 },
    { day: '2026-10-15', confirmedCount: 1, soldAmountCents: 100 },
  ]);
  assert.equal(tiny.bars[1].ratio, 0.02);
  assert.match(tiny.summary, /^Últimos 2 dias · .* em 2 pedidos$/u);
  assert.match(
    dailySalesChart([WEEK[6]]).summary,
    /^Últimos 1 dia · .* em 12 pedidos$/u,
  );
  // FIN-02 / T130: no read (or an older server without `daily`) never
  // draws a week of zeros.
  for (const chart of [
    dailySalesChart(WEEK, { loaded: false }),
    dailySalesChart(undefined),
    dailySalesChart([]),
  ]) {
    assert.deepEqual(chart, {
      available: false,
      bars: [],
      description: '',
      summary: 'Últimos 7 dias',
    });
  }
});

test('Painel: "Atendimento agora" links three rows into the Inbox', () => {
  const rows = attendanceRows({
    ...CALM_QUEUE,
    generatedAt: NOW,
    assistant: { activeCount: 4, stalledCount: 0, failedDeliveryCount: 0 },
    unanswered: UNANSWERED,
    waitingHandoff: {
      count: 3,
      oldestSince: '2026-10-15T14:48:00.000Z',
      overdueCount: 1,
    },
  });
  assert.deepEqual(rows, [
    {
      key: 'waiting',
      label: 'Esperando vendedor',
      to: { path: '/inbox', query: { situacao: 'aguardando' } },
      detail: 'O primeiro espera há 12 min',
      detailTone: null,
      tone: 'warning',
      value: '3',
    },
    {
      key: 'assistant',
      label: 'Com o assistente',
      to: { path: '/inbox', query: { situacao: 'agente' } },
      detail: 'Respondendo normalmente',
      detailTone: 'success',
      tone: null,
      value: '4',
    },
    {
      key: 'unanswered',
      label: 'Sem resposta há mais de 15 min',
      to: { path: '/inbox', query: { situacao: 'vendedor' } },
      detail: '3 de Bruno T. · 1 de Pedro M. · 1 de Ana · +2',
      detailTone: null,
      tone: null,
      value: '7',
    },
  ]);

  const calm = attendanceRows({
    generatedAt: NOW,
    assistant: {
      activeCount: 2,
      stalledCount: 1,
      stallMinutes: 10,
      failedDeliveryCount: 0,
    },
    unanswered: { thresholdMinutes: 20, count: 0, bySeller: [] },
    waitingHandoff: { count: 0, oldestSince: null, overdueCount: 0 },
  });
  assert.equal(calm[0].detail, 'Ninguém esperando');
  assert.equal(calm[0].tone, null);
  assert.equal(calm[0].value, '0');
  assert.equal(calm[1].detail, '1 sem resposta há 10 min ou mais');
  assert.equal(calm[1].detailTone, 'warning');
  assert.equal(calm[2].label, 'Sem resposta há mais de 20 min');
  assert.equal(calm[2].detail, 'Todos respondidos');
  assert.equal(calm[2].value, '0');
});

test('Painel: a failed queue reads "—" in every attendance row, never "0"', () => {
  for (const rows of [
    attendanceRows(null),
    attendanceRows(undefined),
    attendanceRows({ ...CALM_QUEUE, unanswered: UNANSWERED }, { failed: true }),
  ]) {
    assert.deepEqual(
      rows.map((row) => [row.value, row.detail, row.tone, row.detailTone]),
      Array.from({ length: 3 }, () => [
        '—',
        'Sem dados da fila agora',
        null,
        null,
      ]),
    );
    assert.deepEqual(
      rows.map((row) => row.to.query.situacao),
      ['aguardando', 'agente', 'vendedor'],
    );
  }
  // An older server without `unanswered`: that one number is unknown.
  const partial = attendanceRows({ ...CALM_QUEUE, generatedAt: NOW });
  assert.equal(partial[0].value, '0');
  assert.equal(partial[2].value, '—');
});

test('Painel: the manager hears about a late seller right after the SLA', () => {
  const unanswered = {
    thresholdMinutes: 15,
    count: 3,
    bySeller: [{ userId: 'seller-b', name: 'Bruno Teixeira', count: 3 }],
  };
  const late = {
    queue: { unanswered },
    summary: { deliveries: { overdueCount: 2 }, pendingCount: 4 },
  };
  assert.deepEqual(stepFor(true, late), {
    key: 'unanswered',
    label: 'Bruno T. tem 3 conversas sem resposta há mais de 15 minutos.',
    action: 'Ver conversas de Bruno',
    to: { path: '/inbox', query: { responsavel: 'seller-b' } },
  });
  assert.equal(
    stepFor(true, {
      queue: {
        unanswered: {
          ...unanswered,
          bySeller: [{ userId: 'seller-a', name: 'Ana', count: 1 }],
        },
      },
    }).label,
    'Ana tem 1 conversa sem resposta há mais de 15 minutos.',
  );
  // The SLA still comes first.
  assert.equal(
    stepFor(true, {
      ...late,
      queue: { ...late.queue, waitingHandoff: { count: 2, overdueCount: 1 } },
    }).key,
    'out-of-sla',
  );
  // Nobody late, no breakdown (older server) or a failing queue: skipped.
  for (const changes of [
    { queue: { unanswered: { ...unanswered, bySeller: [] } } },
    { queue: { unanswered: null } },
    { queue: { unanswered }, queueError: 'Não foi possível consultar.' },
  ]) {
    assert.equal(
      stepFor(true, { ...changes, summary: late.summary }).key,
      'late-deliveries',
    );
  }
  // The seller's own next step never reads the team's breakdown.
  assert.equal(stepFor(false, { queue: { unanswered } }).key, 'calm');
});

test('Painel: every next step with a destination names its button', () => {
  const cases = [false, true].flatMap((isManager) =>
    [
      { queue: { mine: { awaitingReplyCount: 2 } } },
      { queue: { waitingHandoff: { count: 2, overdueCount: 1 } } },
      { queue: { mine: { pendingOrderCount: 2 } } },
      { queue: { assistant: { stalledCount: 1 } } },
      { summary: { deliveries: { overdueCount: 2 } } },
      { summary: { pendingCount: 2 } },
      {},
    ].map((changes) => stepFor(isManager, changes)),
  );
  for (const step of cases) {
    if (step.to) assert.match(step.action, /^Ver /u);
    else assert.equal(step.action, '');
  }
  assert.deepEqual([...new Set(cases.map((step) => step.action))].sort(), [
    '',
    'Ver assistente',
    'Ver conversas',
    'Ver entregas',
    'Ver pedidos',
  ]);
});
