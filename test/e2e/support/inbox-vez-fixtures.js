// @ts-nocheck -- synthetic fixtures for the Caixa e2e specs.
// RFC 052 prototype fixtures: synthetic people and messages only (no real
// names, phones or customer content). Times are relative to a fixed NOW on a
// Friday afternoon in São Paulo, inside business hours.
export const NOW = '2026-11-06T17:30:00.000Z';
export const ME = { id: 'seller-bia', name: 'Bia Souza' };
export const OTHER = { id: 'seller-carlos', name: 'Carlos Lima' };

/** Saturday 12:00 in São Paulo: outside opening hours (D3 scenes). */
export const OFF_HOURS_NOW = '2026-11-07T15:00:00.000Z';

/**
 * Policy expediente-v1: Mon-Fri 09:00-12:00 and 13:00-18:00, America/Sao_Paulo
 * (UTC-3, no DST in 2026), no holidays. Whole minutes.
 * @param {string|number|Date} from @param {string|number|Date} to
 */
export function businessMinutesBetween(from, to) {
  const offset = 3 * 3_600_000;
  const start = new Date(from).getTime() - offset;
  const end = new Date(to).getTime() - offset;
  if (!(end > start)) return 0;
  const dayMs = 86_400_000;
  let total = 0;
  for (let day = Math.floor(start / dayMs) * dayMs; day < end; day += dayMs) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (const [open, close] of [
      [540, 720],
      [780, 1080],
    ]) {
      const low = Math.max(start, day + open * 60_000);
      const high = Math.min(end, day + close * 60_000);
      if (high > low) total += high - low;
    }
  }
  return Math.floor(total / 60_000);
}

/**
 * @param {string} [nowIso] server clock all relative times hang from
 * @param {{extras?: boolean, bulk?: boolean}} [options] extras: round-2
 *   fixtures; bulk: fillers that push the P1-C targets past page one.
 */
export function buildItems(
  nowIso = NOW,
  { extras = false, bulk = false } = {},
) {
  const NOW_MS = Date.parse(nowIso);
  /** @param {number} minutes */
  const ago = (minutes) => new Date(NOW_MS - minutes * 60_000).toISOString();
  const HOUR = 60;
  const DAY = 1440;

  let sequence = 0;
  /**
   * @param {string} id
   * @param {string} label
   * @param {Record<string, any>} overrides
   */
  function conversation(id, label, overrides = {}) {
    sequence += 1;
    const { message = {}, bucket, turnSince, ...rest } = overrides;
    const lastMessage = {
      id: `message-${id}`,
      type: 'text',
      direction: 'inbound',
      authorKind: 'contact',
      preview: 'Mensagem sintética.',
      text: 'Mensagem sintética.',
      status: 'received',
      occurredAt: turnSince,
      ...message,
    };
    lastMessage.text = lastMessage.preview;
    return {
      id,
      version: 3,
      channel: 'whatsapp',
      state: 'em_atendimento',
      automationState: 'human',
      automationEpoch: 1,
      assignedUser: { id: ME.id, name: ME.name, functionName: 'Vendedor' },
      handoff: null,
      terminalAt: null,
      archivedAt: null,
      openedAt: ago(20 * DAY + sequence),
      contact: {
        id: `contact-${id}`,
        label,
        displayName: label,
        externalId: '5500000000000',
      },
      lastMessage,
      deliveryIssue: null,
      reviewOrder: null,
      order: null,
      requiresAttention: false,
      updatedAt: lastMessage.occurredAt,
      waitingSince: bucket === 'respond' ? turnSince : null,
      queuePosition: bucket === 'respond' ? turnSince : null,
      // RFC 052 fields.
      bucket,
      turnSince,
      turnBusinessMinutes: businessMinutesBetween(turnSince, nowIso),
      assistantStalled: false,
      lostOutcome: null,
      reminder: null,
      ...rest,
    };
  }

  const readyOrder = (number) => ({
    id: `order-${number}`,
    number: `${number}-CRM`,
    status: 'pendente',
    readyForConfirmation: true,
  });
  const outbound = (preview, extra = {}) => ({
    direction: 'outbound',
    authorKind: 'human',
    status: 'delivered',
    deliveryStatus: 'delivered',
    preview,
    ...extra,
  });
  const agent = (preview) => ({
    direction: 'outbound',
    authorKind: 'assistant',
    status: 'delivered',
    deliveryStatus: 'delivered',
    preview,
  });
  const unassigned = { assignedUser: null };
  const other = {
    assignedUser: { id: OTHER.id, name: OTHER.name, functionName: 'Vendedor' },
  };

  /** Responder: failures first, then the longest wait (business minutes). */
  const respond = [
    conversation('r-ana', 'Cliente Ana T.', {
      bucket: 'respond',
      turnSince: ago(58),
      turnBusinessMinutes: 58,
      message: outbound('Segue o orçamento das 30 camisetas com a arte.', {
        status: 'failed',
        deliveryStatus: 'failed',
        occurredAt: ago(41),
      }),
      deliveryIssue: { status: 'failed', occurredAt: ago(41) },
    }),
    conversation('r-bruno', 'Cliente Bruno M.', {
      ...other,
      bucket: 'respond',
      turnSince: ago(36),
      turnBusinessMinutes: 36,
      message: outbound('Confirmo o tamanho G para as 12 peças?', {
        status: 'outcome_unknown',
        deliveryStatus: 'outcome_unknown',
        occurredAt: ago(22),
      }),
      deliveryIssue: { status: 'outcome_unknown', occurredAt: ago(22) },
    }),
    conversation('r-fabio', 'Cliente Fábio R.', {
      bucket: 'respond',
      // Wrote last night at 21:15; only today's opening hours count.
      turnSince: ago(20 * HOUR + 15),
      turnBusinessMinutes: 6 * HOUR + 30,
      message: { preview: 'Boa noite, ainda dá tempo de pedir para o dia 20?' },
    }),
    conversation(
      'r-carla',
      'Cliente Carla Regina Albuquerque de Souza Mendonça',
      {
        ...unassigned,
        state: 'requer_atencao',
        bucket: 'respond',
        turnSince: ago(3 * HOUR + 5),
        turnBusinessMinutes: 3 * HOUR + 5,
        handoff: {
          id: 'handoff-r-carla',
          status: 'pending',
          reasonCode: 'urgency',
          createdAt: ago(3 * HOUR + 5),
          targetRole: 'Vendedor',
          version: 1,
        },
        message: {
          preview: 'Preciso das camisas da formatura até quarta, consegue?',
        },
      },
    ),
    conversation('r-iris', 'Cliente Íris C.', {
      ...other,
      bucket: 'respond',
      turnSince: ago(80),
      turnBusinessMinutes: 80,
      message: { preview: 'Pode ser azul-marinho no lugar do preto?' },
    }),
    conversation('r-diego', 'Cliente Diego F.', {
      ...unassigned,
      automationState: 'assistant',
      bucket: 'respond',
      turnSince: ago(48),
      turnBusinessMinutes: 48,
      assistantStalled: true,
      message: { preview: 'Vocês entregam em Campinas?' },
    }),
    conversation('r-elisa', 'Cliente Elisa P.', {
      bucket: 'respond',
      turnSince: ago(27),
      turnBusinessMinutes: 27,
      handoff: {
        id: 'handoff-r-elisa',
        status: 'accepted',
        reasonCode: 'briefing_complete',
        createdAt: ago(2 * HOUR),
        targetRole: 'Vendedor',
        version: 2,
      },
      reviewOrder: readyOrder('07'),
      order: readyOrder('07'),
      message: { preview: 'Fechado! Pode mandar o pedido para eu aprovar.' },
    }),
    conversation('r-joao', 'Cliente João V.', {
      bucket: 'respond',
      turnSince: ago(15),
      turnBusinessMinutes: 15,
      message: { preview: 'Qual o prazo para bordado no peito?' },
    }),
    conversation('r-hugo', 'Cliente Hugo N.', {
      channel: 'site_chat',
      bucket: 'respond',
      turnSince: ago(12),
      turnBusinessMinutes: 12,
      contact: {
        id: 'contact-r-hugo',
        label: 'Cliente Hugo N.',
        displayName: 'Cliente Hugo N.',
        externalId: 'site-visitor-hugo',
        phone: null,
      },
      message: {
        preview: 'Oi, vi o catálogo no site. Fazem uniforme de cozinha?',
      },
    }),
    conversation('r-gabi', 'Cliente Gabi L.', {
      ...unassigned,
      bucket: 'respond',
      turnSince: ago(3),
      turnBusinessMinutes: 3,
      message: {
        preview: 'Oi! Quero fazer 15 moletons com o logo da empresa.',
      },
    }),
  ];

  /** Aguardando cliente: the team spoke last, under 72 h; newest first. */
  const awaiting = [
    conversation('a-katia', 'Cliente Kátia B.', {
      bucket: 'awaiting',
      turnSince: ago(10),
      message: outbound('Perfeito, te mando o layout até amanhã cedo.'),
    }),
    conversation('a-lucas', 'Cliente Lucas D.', {
      ...unassigned,
      automationState: 'assistant',
      bucket: 'awaiting',
      turnSince: ago(25),
      message: agent('Qual o tamanho de cada peça? Pode mandar a grade.'),
    }),
    conversation('a-marina', 'Cliente Marina O.', {
      bucket: 'awaiting',
      turnSince: ago(2 * HOUR),
      reviewOrder: readyOrder('11'),
      order: readyOrder('11'),
      message: outbound('O pedido 11-CRM está pronto para você conferir.'),
    }),
    conversation('a-nelson', 'Cliente Nelson G.', {
      ...other,
      bucket: 'awaiting',
      turnSince: ago(5 * HOUR + 10),
      message: outbound('Mandei as duas opções de gola, qual prefere?'),
    }),
    conversation('a-olivia', 'Cliente Olívia S.', {
      bucket: 'awaiting',
      turnSince: ago(22 * HOUR + 30),
      message: outbound('Consegue me confirmar o endereço de entrega?'),
    }),
    conversation('a-paulo', 'Cliente Paulo H.', {
      channel: 'site_chat',
      bucket: 'awaiting',
      turnSince: ago(DAY + 6 * HOUR),
      message: outbound('Te enviei a tabela de tamanhos por aqui.'),
    }),
    conversation('a-quesia', 'Cliente Quésia A.', {
      bucket: 'awaiting',
      turnSince: ago(2 * DAY),
      message: agent('Recebi sua arte! Uma pessoa da equipe vai revisar.'),
      automationState: 'human',
    }),
    conversation('a-rafael', 'Cliente Rafael T.', {
      ...unassigned,
      bucket: 'awaiting',
      turnSince: ago(2 * DAY + 20 * HOUR),
      message: outbound('Fico no aguardo da quantidade final.'),
    }),
  ];

  /** Sem retorno: the customer has been quiet for 72 h or more; oldest first. */
  const silent = [
    conversation('s-sabrina', 'Cliente Sabrina K.', {
      bucket: 'silent',
      turnSince: ago(12 * DAY),
      message: outbound('Conseguiu ver com a diretoria a quantidade?'),
    }),
    conversation('s-tiago', 'Cliente Tiago W.', {
      ...other,
      bucket: 'silent',
      turnSince: ago(9 * DAY + 3 * HOUR),
      message: outbound('Segue o link do pagamento do sinal.'),
    }),
    conversation('s-ursula', 'Cliente Úrsula F.', {
      bucket: 'silent',
      turnSince: ago(7 * DAY),
      // A reminder that came due brings it back to Sem retorno (ACT-05).
      reminder: { remindAt: ago(2 * HOUR + 30), userId: ME.id },
      message: outbound('Te lembro na segunda, combinado?'),
    }),
    conversation('s-vitor', 'Cliente Vítor E.', {
      bucket: 'silent',
      turnSince: ago(5 * DAY),
      reviewOrder: readyOrder('09'),
      order: readyOrder('09'),
      message: outbound('O pedido 09-CRM está pronto, só falta o seu ok.'),
    }),
    conversation('s-wanda', 'Cliente Wanda R.', {
      bucket: 'silent',
      turnSince: ago(4 * DAY + 2 * HOUR),
      message: outbound('Conseguiu ver a proposta das 40 camisetas?'),
    }),
    conversation('s-xavier', 'Cliente Xavier P.', {
      ...unassigned,
      automationState: 'assistant',
      bucket: 'silent',
      turnSince: ago(3 * DAY + 4 * HOUR),
      message: agent('Posso te ajudar com mais alguma informação?'),
    }),
    conversation('s-yara', 'Cliente Yara M.', {
      channel: 'site_chat',
      bucket: 'silent',
      turnSince: ago(3 * DAY + HOUR),
      message: outbound('Mandei o orçamento por e-mail também.'),
    }),
    conversation('s-zeca', 'Cliente Zeca J.', {
      ...unassigned,
      bucket: 'silent',
      turnSince: ago(3 * DAY + 10),
      message: outbound('Qualquer dúvida, é só chamar.'),
    }),
  ];

  /** Perdidos: an active declared loss (MET-07); the latest first. */
  const lost = [
    ['l-alice', 'Cliente Alice N.', 'preco', 7 * HOUR + 18],
    ['l-bento', 'Cliente Bento C.', 'prazo', DAY + 3 * HOUR],
    ['l-celia', 'Cliente Célia T.', 'concorrente', 2 * DAY + 5 * HOUR, other],
    ['l-davi', 'Cliente Davi L.', 'silencio', 3 * DAY + HOUR],
    ['l-edu', 'Cliente Edu S.', 'indisponivel', 5 * DAY],
    ['l-flora', 'Cliente Flora V.', 'outro', 7 * DAY],
    ['l-gil', 'Cliente Gil P.', 'preco', 9 * DAY],
  ].map(([id, label, reasonCode, minutes, owner]) =>
    conversation(id, label, {
      ...(owner ?? {}),
      bucket: 'lost',
      turnSince: ago(minutes + 2 * DAY),
      lostOutcome: { reasonCode, occurredAt: ago(minutes), version: 1 },
      message: outbound('Obrigada pelo retorno, fico à disposição.'),
    }),
  );

  const archived = [
    conversation('x-helena', 'Cliente Helena Q.', {
      bucket: undefined,
      turnSince: ago(15 * DAY),
      archivedAt: ago(10 * DAY),
      message: { preview: 'Era engano, desculpa.' },
    }),
  ];

  /**
   * Round 2 (RFC 052), opt-in via `extras`. Each id covers one case:
   *  v-assumir        respond, pending handoff, no owner        -> selo "Assumir" (D8)
   *  v-foraexp        respond, wrote after closing, 0 business min -> "fora do expediente" (D3,
   *                   needs the clock at OFF_HOURS_NOW; on any other clock the count is simply real)
   *  v-dias           respond, 2 d 3 h of calendar time          -> "2 d" with the alert still on (D4)
   *  v-lembrete-meu   silent, future reminder by ME              -> shown under Aguardando for ME (D2)
   *  v-lembrete-outro silent, future reminder by OTHER           -> stays in Sem retorno, mine:false (D2)
   *  v-reaberta       silent, owner ME, a loss already reopened once: no active
   *                   lostOutcome, but the latest outcome event is version 2 (A1)
   *  v-perdido-selos  lost, owner + urgent + delivery + stalled + ready + reminder (P1-B)
   *  v-fora-silencio  silent, newest of Sem retorno (past page one with `bulk`) (P1-C)
   *  v-fora-perdido   lost, oldest of Perdidos (past page one with `bulk`)       (P1-C)
   */
  const closedAt = Date.parse('2026-11-06T21:30:00.000Z');
  const extraItems = [
    conversation('v-assumir', 'Cliente Heitor Z.', {
      ...unassigned,
      state: 'requer_atencao',
      bucket: 'respond',
      turnSince: ago(40),
      turnBusinessMinutes: 40,
      handoff: {
        id: 'handoff-v-assumir',
        status: 'pending',
        reasonCode: 'briefing_complete',
        createdAt: ago(40),
        targetRole: 'Vendedor',
        version: 1,
      },
      message: { preview: 'Pode me passar o valor com a estampa nas costas?' },
    }),
    conversation('v-foraexp', 'Cliente Irene B.', {
      bucket: 'respond',
      turnSince: new Date(
        Math.min(closedAt, NOW_MS - 5 * 60_000),
      ).toISOString(),
      message: {
        preview: 'Boa noite! Só vi o catálogo agora, vocês atendem sábado?',
      },
    }),
    conversation('v-dias', 'Cliente Jonas Q.', {
      bucket: 'respond',
      turnSince: ago(2 * DAY + 3 * HOUR),
      message: { preview: 'Ainda estou aguardando o orçamento das camisas.' },
    }),
    conversation('v-lembrete-meu', 'Cliente Lívia A.', {
      bucket: 'silent',
      turnSince: ago(6 * DAY),
      reminder: { remindAt: ago(-2 * DAY), userId: ME.id },
      message: outbound('Combinado, volto a falar com você na segunda.'),
    }),
    conversation('v-lembrete-outro', 'Cliente Mateus R.', {
      bucket: 'silent',
      turnSince: ago(6 * DAY + HOUR),
      reminder: { remindAt: ago(-2 * DAY), userId: OTHER.id },
      message: outbound('Fico no aguardo da aprovação da diretoria.'),
    }),
    conversation('v-reaberta', 'Cliente Rita G.', {
      bucket: 'silent',
      turnSince: ago(8 * DAY),
      outcomeVersion: 2,
      message: outbound('Voltei a falar com o time, aguardo o retorno.'),
    }),
    conversation('v-perdido-selos', 'Cliente Nina F.', {
      ...other,
      bucket: 'lost',
      turnSince: ago(4 * DAY),
      assistantStalled: true,
      deliveryIssue: { status: 'failed', occurredAt: ago(3 * DAY) },
      handoff: {
        id: 'handoff-v-perdido-selos',
        status: 'pending',
        reasonCode: 'urgency',
        createdAt: ago(3 * DAY),
        targetRole: 'Vendedor',
        version: 1,
      },
      reviewOrder: readyOrder('21'),
      order: readyOrder('21'),
      reminder: { remindAt: ago(-3 * DAY), userId: OTHER.id },
      lostOutcome: {
        reasonCode: 'concorrente',
        occurredAt: ago(2 * DAY),
        version: 1,
      },
      message: outbound('Segue o orçamento final com o desconto combinado.', {
        status: 'failed',
        deliveryStatus: 'failed',
        occurredAt: ago(3 * DAY),
      }),
    }),
    conversation('v-fora-silencio', 'Cliente Otávio D.', {
      bucket: 'silent',
      turnSince: ago(3 * DAY + 30),
      message: outbound('Alguma novidade sobre o pedido do time?'),
    }),
    conversation('v-fora-perdido', 'Cliente Priscila E.', {
      bucket: 'lost',
      turnSince: ago(42 * DAY),
      lostOutcome: {
        reasonCode: 'prazo',
        occurredAt: ago(40 * DAY),
        version: 1,
      },
      message: outbound('Sem problema, quando precisar é só chamar.'),
    }),
  ];

  const fillers = Array.from({ length: 104 }, (_, index) => {
    const label = `Cliente Reserva ${String(index + 1).padStart(3, '0')}`;
    return [
      conversation(`f-silencio-${index + 1}`, label, {
        bucket: 'silent',
        turnSince: ago(30 * DAY + index),
        message: outbound('Mensagem sintética de preenchimento.'),
      }),
      conversation(`f-perdido-${index + 1}`, label, {
        bucket: 'lost',
        turnSince: ago(10 * DAY),
        lostOutcome: {
          reasonCode: 'preco',
          occurredAt: ago(1 + index * 3),
          version: 1,
        },
        message: outbound('Mensagem sintética de preenchimento.'),
      }),
    ];
  }).flat();

  return [
    ...respond,
    ...awaiting,
    ...silent,
    ...lost,
    ...archived,
    ...(extras ? extraItems : []),
    ...(bulk ? fillers : []),
  ];
}

export const ITEMS = buildItems();

/** @param {Record<string, any>} item */
export function threadOf(item) {
  const first = {
    id: `first-${item.id}`,
    type: 'text',
    direction: 'inbound',
    authorKind: 'contact',
    preview: 'Olá, gostaria de um orçamento de uniformes.',
    text: 'Olá, gostaria de um orçamento de uniformes.',
    status: 'received',
    occurredAt: new Date(
      Date.parse(item.turnSince) - 90 * 60_000,
    ).toISOString(),
  };
  const reply = {
    id: `reply-${item.id}`,
    type: 'text',
    direction: 'outbound',
    authorKind: 'human',
    author: { id: ME.id, name: ME.name },
    preview: 'Claro! Quantas peças e para quando?',
    text: 'Claro! Quantas peças e para quando?',
    status: 'delivered',
    deliveryStatus: 'delivered',
    occurredAt: new Date(
      Date.parse(item.turnSince) - 60 * 60_000,
    ).toISOString(),
  };
  return [first, reply, item.lastMessage];
}
