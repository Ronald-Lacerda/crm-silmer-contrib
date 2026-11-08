// Painel (pesquisa de UX de 15/10/2026, achado 2): textos dos indicadores.
// Os números e o relógio vêm do servidor; aqui só se escolhem as palavras.

const moneyFormatter = new Intl.NumberFormat('pt-BR', {
  currency: 'BRL',
  style: 'currency',
});
const weekdayFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  weekday: 'long',
});

export const PERIODS = Object.freeze([
  Object.freeze({ key: 'hoje', label: 'Hoje', sold: 'Vendido hoje' }),
  Object.freeze({ key: '7dias', label: '7 dias', sold: 'Vendido em 7 dias' }),
  Object.freeze({ key: 'mes', label: 'Mês', sold: 'Vendido no mês' }),
]);

/** @param {unknown} cents */
export function money(cents) {
  return moneyFormatter.format(Number(cents || 0) / 100);
}

/** @param {number} count @param {string} one @param {string} many */
export function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** @param {unknown} value */
function count(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

/**
 * "há 25 min", "há 3 h", "há 2 dias", read between two server instants so a
 * wrong clock on the phone does not change the answer.
 *
 * @param {unknown} since @param {unknown} now
 */
export function elapsedLabel(since, now) {
  const from = Date.parse(String(since ?? ''));
  const to = Date.parse(String(now ?? ''));
  if (Number.isNaN(from) || Number.isNaN(to)) return '';
  const minutes = Math.max(0, Math.floor((to - from) / 60_000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${plural(Math.floor(hours / 24), 'dia', 'dias')}`;
}

/** "10/10" for a YYYY-MM-DD day. @param {unknown} day */
export function shortDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day ?? ''));
  return match ? `${match[3]}/${match[2]}` : '';
}

/** "quinta-feira, 15 de outubro" for a YYYY-MM-DD day. @param {unknown} day */
export function longDay(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day ?? ''));
  if (!match) return '';
  const label = weekdayFormatter.format(
    new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    ),
  );
  return label.charAt(0).toLocaleUpperCase('pt-BR') + label.slice(1);
}

/**
 * @typedef {{value: string, detail: string, tone: 'error'|'warning'|'success'|null, badge: string}} Indicator
 */

/**
 * The reader's own open conversations and how many end on the client.
 *
 * @param {Record<string, any>|undefined} mine @param {unknown} now
 * @returns {Indicator}
 */
export function mineIndicator(mine, now) {
  const total = count(mine?.count);
  const awaiting = count(mine?.awaitingReplyCount);
  if (awaiting > 0) {
    const oldest = elapsedLabel(mine?.oldestAwaitingSince, now);
    return {
      badge: 'Cliente esperando',
      detail: `${plural(awaiting, 'cliente espera', 'clientes esperam')} sua resposta${oldest ? `; o primeiro escreveu ${oldest}` : ''}`,
      tone: 'warning',
      value: String(total),
    };
  }
  return {
    badge: '',
    detail: total
      ? 'Nenhum cliente esperando sua resposta'
      : 'Nenhuma conversa com você agora',
    tone: null,
    value: String(total),
  };
}

/**
 * Seller home: the clients waiting for the reader's answer right now.
 *
 * @param {Record<string, any>|undefined} mine @param {unknown} now
 * @returns {Indicator}
 */
export function replyIndicator(mine, now) {
  const total = count(mine?.count);
  const awaiting = count(mine?.awaitingReplyCount);
  if (!awaiting) {
    return {
      badge: '',
      detail: total
        ? `Ninguém esperando; ${plural(total, 'conversa sua', 'conversas suas')} em andamento`
        : 'Nenhuma conversa com você agora',
      tone: null,
      value: '0',
    };
  }
  const oldest = elapsedLabel(mine?.oldestAwaitingSince, now);
  return {
    badge: '',
    detail: oldest
      ? `O primeiro cliente escreveu ${oldest}`
      : `${plural(awaiting, 'cliente espera', 'clientes esperam')} sua resposta`,
    tone: 'warning',
    value: String(awaiting),
  };
}

/** Seller home: the reader's own pending orders. @param {unknown} pending @returns {Indicator} */
export function myOrdersIndicator(pending) {
  const total = count(pending);
  return {
    badge: '',
    detail: total
      ? 'Ainda sem valor e condição confirmados'
      : 'Nenhum pedido seu esperando confirmação',
    tone: null,
    value: String(total),
  };
}

/**
 * Handoffs nobody took yet. The SLA (`due_at`) is the server's; "parada"
 * counts from the handoff, as in the Inbox (PCX-03/A02).
 *
 * @param {Record<string, any>|undefined} waiting @param {unknown} now
 * @returns {Indicator}
 */
export function waitingIndicator(waiting, now) {
  const total = count(waiting?.count);
  const overdue = count(waiting?.overdueCount);
  if (!total) {
    return {
      badge: '',
      detail: 'Nenhuma conversa esperando por uma pessoa',
      tone: null,
      value: '0',
    };
  }
  const oldest = elapsedLabel(waiting?.oldestSince, now);
  // Short enough for half a phone row: the badge says how many broke the
  // SLA, the detail how long the oldest has been stalled.
  return {
    badge: overdue ? `${overdue} fora do prazo` : '',
    detail: oldest
      ? `A mais antiga está parada ${oldest}`
      : 'Dentro do prazo de resposta',
    tone: overdue ? 'error' : 'warning',
    value: String(total),
  };
}

/**
 * The assistant's health: conversations it holds, client messages it left
 * unanswered past the server's threshold and sends that failed in 24 hours.
 *
 * @param {Record<string, any>|undefined} assistant @param {unknown} now
 * @returns {Indicator}
 */
export function assistantIndicator(assistant, now) {
  const active = count(assistant?.activeCount);
  const stalled = count(assistant?.stalledCount);
  const failed = count(assistant?.failedDeliveryCount);
  const lastReply = elapsedLabel(assistant?.lastReplyAt, now);
  if (stalled || failed) {
    // Counts of conversations, short enough for half a phone row.
    const problems = [];
    if (stalled) {
      problems.push(
        `${stalled} sem resposta há ${Number(assistant?.stallMinutes) || 10} min ou mais`,
      );
    }
    if (failed) problems.push(`${failed} com envio falho em 24 h`);
    return {
      badge: 'Atenção',
      detail: problems.join('; '),
      tone: 'warning',
      value: 'Pede atenção',
    };
  }
  const reply = lastReply ? `última resposta ${lastReply}` : '';
  if (active) {
    return {
      badge: '',
      detail: [
        `${plural(active, 'conversa', 'conversas')} com o assistente`,
        reply,
      ]
        .filter(Boolean)
        .join('; '),
      tone: 'success',
      value: 'Respondendo',
    };
  }
  return {
    badge: '',
    detail: reply ? `Ú${reply.slice(1)}` : 'Nenhuma resposta nas últimas 24 h',
    tone: null,
    value: 'Sem conversas agora',
  };
}

/**
 * Confirmed sales of the chosen period, with the period's average ticket.
 *
 * @param {Record<string, any>|undefined} period
 * @returns {Indicator}
 */
export function soldIndicator(period) {
  const confirmed = count(period?.confirmedCount);
  const amount = Number(period?.soldAmountCents || 0);
  return {
    badge: '',
    detail: confirmed
      ? `${plural(confirmed, 'pedido confirmado', 'pedidos confirmados')}; ticket médio ${money(Math.round(amount / confirmed))}`
      : 'Nenhum pedido confirmado no período',
    tone: null,
    value: money(amount),
  };
}

/** @param {unknown} pending @returns {Indicator} */
export function pendingIndicator(pending) {
  const total = count(pending);
  return {
    badge: '',
    detail: total
      ? 'Ainda sem valor e condição confirmados'
      : 'Nenhum pedido esperando confirmação',
    tone: null,
    value: String(total),
  };
}

/** @param {Record<string, any>|undefined} deliveries @returns {Indicator} */
export function overdueIndicator(deliveries) {
  const total = count(deliveries?.overdueCount);
  const oldest = shortDay(deliveries?.oldestOverdueOn);
  // The label already says "atrasadas"; the value carries the error tone.
  return {
    badge: '',
    detail: total
      ? oldest
        ? `A mais antiga era para ${oldest}`
        : 'Previstas para antes de hoje e ainda não entregues'
      : 'Nenhuma previsão de entrega passou do dia',
    tone: total ? 'error' : null,
    value: String(total),
  };
}

/**
 * PNL-03: a queue card when the queue could not be read. It never reads as
 * "0": nothing is known, so the value is a dash.
 *
 * @returns {Indicator}
 */
export function unavailableIndicator() {
  return {
    badge: '',
    detail: 'Sem dados da fila agora',
    tone: null,
    value: '—',
  };
}

/**
 * `action` is the text of the banner's button; empty when `to` is null.
 *
 * @typedef {{key: string, label: string, action: string, to: {path: string, query: Record<string, string>}|null}} NextStep
 */

/**
 * PNL-01 (RFC 024, proposta D): the one thing to do now, by role, from the
 * summaries the Painel already reads. The first rule with something pending
 * wins. While the queue fails, the rules that read it are skipped; nothing is
 * invented from a missing number, and the step never says "nada urgente"
 * when it could not look at the queue.
 *
 * @param {{isManager?: boolean, summary?: Record<string, any>|null, queue?: Record<string, any>|null, queueError?: unknown}} input
 * @returns {NextStep}
 */
export function nextStep({ isManager, summary, queue, queueError }) {
  const hasQueue = Boolean(queue) && !queueError;
  const lateDeliveries = count(summary?.deliveries?.overdueCount);
  /** @type {Array<NextStep|null>} */
  const rules = [];
  if (isManager) {
    const outOfSla = hasQueue ? count(queue?.waitingHandoff?.overdueCount) : 0;
    const assistant = hasQueue ? queue?.assistant : null;
    const pending = count(summary?.pendingCount);
    const seller = hasQueue ? topUnansweredSeller(queue?.unanswered) : null;
    rules.push(
      outOfSla
        ? {
            key: 'out-of-sla',
            label: `Atender ${plural(outOfSla, 'conversa', 'conversas')} fora do prazo`,
            action: 'Ver conversas',
            to: { path: '/inbox', query: { situacao: 'aguardando' } },
          }
        : null,
      // PNL-06: right after the SLA, the seller with the most conversations
      // left without an answer opens the Inbox on their conversations.
      seller
        ? {
            key: 'unanswered',
            label: `${seller.short} tem ${plural(seller.count, 'conversa', 'conversas')} sem resposta há mais de ${seller.minutes} minutos.`,
            action: seller.first
              ? `Ver conversas de ${seller.first}`
              : 'Ver conversas do vendedor',
            to: { path: '/inbox', query: { responsavel: seller.userId } },
          }
        : null,
      lateDeliveries
        ? {
            key: 'late-deliveries',
            label: `Conferir ${plural(lateDeliveries, 'entrega atrasada', 'entregas atrasadas')}`,
            action: 'Ver entregas',
            to: { path: '/pedidos', query: { entrega: 'atrasada' } },
          }
        : null,
      count(assistant?.stalledCount) || count(assistant?.failedDeliveryCount)
        ? {
            key: 'assistant',
            label: 'Verificar as conversas do assistente',
            action: 'Ver assistente',
            to: { path: '/inbox', query: { situacao: 'agente' } },
          }
        : null,
      pending
        ? {
            key: 'pending',
            label: `Confirmar ${plural(pending, 'pedido pendente', 'pedidos pendentes')}`,
            action: 'Ver pedidos',
            to: { path: '/pedidos', query: { status: 'pendente' } },
          }
        : null,
    );
  } else {
    const awaiting = hasQueue ? count(queue?.mine?.awaitingReplyCount) : 0;
    const waiting = hasQueue ? count(queue?.waitingHandoff?.count) : 0;
    const myPending = hasQueue ? count(queue?.mine?.pendingOrderCount) : 0;
    rules.push(
      awaiting
        ? {
            key: 'reply',
            label: `Responder ${plural(awaiting, 'conversa', 'conversas')}`,
            action: 'Ver conversas',
            to: { path: '/inbox', query: { fila: 'minhas' } },
          }
        : null,
      waiting
        ? {
            key: 'take-over',
            label: `Assumir ${plural(waiting, 'conversa em espera', 'conversas em espera')}`,
            action: 'Ver conversas',
            to: { path: '/inbox', query: { situacao: 'aguardando' } },
          }
        : null,
      myPending
        ? {
            key: 'my-pending',
            label: `Completar ${plural(myPending, 'pedido pendente', 'pedidos pendentes')}`,
            action: 'Ver pedidos',
            to: {
              path: '/pedidos',
              query: { status: 'pendente', vendedor: 'eu' },
            },
          }
        : null,
      lateDeliveries
        ? {
            key: 'late-deliveries',
            label: `Conferir ${plural(lateDeliveries, 'entrega atrasada', 'entregas atrasadas')}`,
            action: 'Ver entregas',
            to: { path: '/pedidos', query: { entrega: 'atrasada' } },
          }
        : null,
    );
  }
  const step = rules.find(Boolean);
  if (step) return step;
  if (!hasQueue) {
    return {
      key: 'queue-unavailable',
      label: 'A fila não respondeu; tente de novo mais abaixo.',
      action: '',
      to: null,
    };
  }
  return { key: 'calm', label: 'Nada urgente agora.', action: '', to: null };
}

/** @param {Record<string, any>|undefined} deliveries @returns {Indicator} */
export function dueSoonIndicator(deliveries) {
  const total = count(deliveries?.dueSoonCount);
  const until = shortDay(deliveries?.dueSoonUntil);
  return {
    badge: '',
    detail: total
      ? `Previstas de hoje${until ? ` até ${until}` : ''}`
      : 'Nenhuma previsão de entrega para os próximos 7 dias',
    tone: null,
    value: String(total),
  };
}

/**
 * "Bruno Teixeira" → "Bruno T."; one word stays as it is.
 *
 * @param {unknown} name
 */
export function shortPersonName(name) {
  const words = String(name ?? '')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length < 2) return words[0] ?? '';
  const last = /** @type {string} */ (words.at(-1));
  return `${words[0]} ${last.charAt(0).toLocaleUpperCase('pt-BR')}.`;
}

/**
 * PNL-06: the seller at the top of the server's "sem resposta" breakdown,
 * with the words the next step needs. Null when nobody is late.
 *
 * @param {Record<string, any>|null|undefined} unanswered
 */
function topUnansweredSeller(unanswered) {
  const seller = Array.isArray(unanswered?.bySeller)
    ? unanswered.bySeller[0]
    : null;
  const total = count(seller?.count);
  if (!seller?.userId || !total) return null;
  const short = shortPersonName(seller.name);
  return {
    count: total,
    first: short ? short.split(' ')[0] : '',
    minutes: count(unanswered?.thresholdMinutes) || 15,
    short: short || 'Um vendedor',
    userId: String(seller.userId),
  };
}

const compactFormatter = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 1,
});

/**
 * A bar's value in few characters: "850", "2 mil", "4,1 mil", "1,2 mi".
 * Whole reais below a thousand; the full value lives in the description.
 *
 * @param {unknown} cents
 */
export function compactReais(cents) {
  const reais = Math.max(0, Number(cents) || 0) / 100;
  if (Math.round(reais) < 1000) return String(Math.round(reais));
  const thousands = Math.round(reais / 100) / 10;
  if (thousands < 1000) return `${compactFormatter.format(thousands)} mil`;
  return `${compactFormatter.format(Math.round(reais / 100_000) / 10)} mi`;
}

/** Short and spoken weekday names, Sunday first (`getUTCDay`). */
const WEEKDAYS = Object.freeze([
  ['Dom', 'domingo'],
  ['Seg', 'segunda'],
  ['Ter', 'terça'],
  ['Qua', 'quarta'],
  ['Qui', 'quinta'],
  ['Sex', 'sexta'],
  ['Sáb', 'sábado'],
]);

/** @param {unknown} day YYYY-MM-DD @returns {string[]} */
function weekday(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(day ?? ''));
  if (!match) return ['', ''];
  const index = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  ).getUTCDay();
  return WEEKDAYS[index];
}

/**
 * @typedef {{day: string, label: string, name: string, value: string, amount: string, ratio: number, current: boolean}} SalesBar
 * @typedef {{available: boolean, summary: string, description: string, bars: SalesBar[]}} SalesChart
 */

/**
 * PNL-05: "Vendido por dia" from `daily` of the orders summary (oldest
 * first, the last one today). Without a successful read there is no chart:
 * FIN-02 / T130 forbid a week of invented zeros. A week without sales keeps
 * a flat baseline (no division by zero).
 *
 * @param {unknown} daily @param {{loaded?: boolean}} [options]
 * @returns {SalesChart}
 */
export function dailySalesChart(daily, { loaded = true } = {}) {
  /** @type {Record<string, any>[]} */
  const days = loaded && Array.isArray(daily) ? daily.slice(-7) : [];
  if (!days.length) {
    return {
      available: false,
      bars: [],
      description: '',
      summary: 'Últimos 7 dias',
    };
  }
  const amounts = days.map((entry) =>
    Math.max(0, Number(entry?.soldAmountCents) || 0),
  );
  const max = Math.max(...amounts);
  const orders = days.reduce(
    (total, entry) => total + count(entry?.confirmedCount),
    0,
  );
  const sum = amounts.reduce((total, amount) => total + amount, 0);
  const bars = days.map((entry, index) => {
    const current = index === days.length - 1;
    const [label, name] = current ? ['Hoje', 'hoje'] : weekday(entry?.day);
    const amount = amounts[index];
    return {
      amount: money(amount),
      current,
      day: String(entry?.day ?? ''),
      label,
      name,
      // A day with any sale keeps a sliver above the baseline.
      ratio: max ? Math.max(amount / max, amount ? 0.02 : 0) : 0,
      value: compactReais(amount),
    };
  });
  return {
    available: true,
    bars,
    description: `Vendido por dia: ${bars.map((bar) => `${bar.name} ${bar.amount}`).join(', ')}`,
    summary: `Últimos ${plural(days.length, 'dia', 'dias')} · ${money(sum)} em ${plural(orders, 'pedido', 'pedidos')}`,
  };
}

/**
 * @typedef {{path: string, query: Record<string, string>}} QueueLink
 * @typedef {{key: string, value: string, label: string, detail: string, tone: 'warning'|null, detailTone: 'success'|'warning'|null, to: QueueLink}} AttendanceRow
 */

/** @returns {Pick<AttendanceRow, 'detail'|'detailTone'|'tone'|'value'>} */
function unknownRow() {
  return {
    detail: 'Sem dados da fila agora',
    detailTone: null,
    tone: null,
    value: '—',
  };
}

/**
 * PNL-06: the three rows of "Atendimento agora". Without any queue read
 * every number is "—" (PNL-03); a missing `unanswered` (older server) is
 * unknown too, never "0".
 *
 * @param {Record<string, any>|null|undefined} queue
 * @param {{failed?: boolean}} [options]
 * @returns {AttendanceRow[]}
 */
export function attendanceRows(queue, { failed = !queue } = {}) {
  const now = queue?.generatedAt;
  const waiting = queue?.waitingHandoff;
  const assistant = queue?.assistant;
  const unanswered = queue?.unanswered;
  const minutes = count(unanswered?.thresholdMinutes) || 15;

  const waitingCount = count(waiting?.count);
  const oldest = elapsedLabel(waiting?.oldestSince, now);
  let waitingDetail = 'Ninguém esperando';
  if (waitingCount) {
    if (oldest === 'agora') waitingDetail = 'O primeiro acabou de chegar';
    else if (oldest) waitingDetail = `O primeiro espera ${oldest}`;
    else waitingDetail = 'Aguardando uma pessoa';
  }
  /** @type {AttendanceRow} */
  const waitingRow = {
    key: 'waiting',
    label: 'Esperando vendedor',
    to: { path: '/inbox', query: { situacao: 'aguardando' } },
    ...(failed
      ? unknownRow()
      : {
          detail: waitingDetail,
          detailTone: null,
          tone: waitingCount ? 'warning' : null,
          value: String(waitingCount),
        }),
  };

  const troubled =
    count(assistant?.stalledCount) || count(assistant?.failedDeliveryCount);
  /** @type {AttendanceRow} */
  const assistantRow = {
    key: 'assistant',
    label: 'Com o assistente',
    to: { path: '/inbox', query: { situacao: 'agente' } },
    ...(failed
      ? unknownRow()
      : {
          detail: troubled
            ? assistantIndicator(assistant, now).detail
            : 'Respondendo normalmente',
          detailTone: troubled ? 'warning' : 'success',
          tone: null,
          value: String(count(assistant?.activeCount)),
        }),
  };

  /** @type {Record<string, any>[]} */
  const sellers = Array.isArray(unanswered?.bySeller)
    ? unanswered.bySeller.filter(
        (/** @type {any} */ seller) => count(seller?.count) > 0,
      )
    : [];
  const unansweredCount = count(unanswered?.count);
  const breakdown = sellers
    .slice(0, 3)
    .map(
      (seller) =>
        `${count(seller.count)} de ${shortPersonName(seller.name) || 'sem nome'}`,
    );
  if (sellers.length > 3) breakdown.push(`+${sellers.length - 3}`);
  const known =
    !failed && Boolean(unanswered) && typeof unanswered === 'object';
  /** @type {AttendanceRow} */
  const unansweredRow = {
    key: 'unanswered',
    label: `Sem resposta há mais de ${minutes} min`,
    to: { path: '/inbox', query: { situacao: 'vendedor' } },
    ...(known
      ? {
          detail: unansweredCount
            ? breakdown.join(' · ') || 'Conversas com vendedores'
            : 'Todos respondidos',
          detailTone: null,
          tone: null,
          value: String(unansweredCount),
        }
      : unknownRow()),
  };

  return [waitingRow, assistantRow, unansweredRow];
}
