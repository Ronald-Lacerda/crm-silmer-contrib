import { brand } from '../brand/index.js';
import { orderReadyToReview } from './inbox-priority.js';

/**
 * RFC 052 (INBOX-VEZ-02): every open conversation sits in exactly one tab,
 * by whose turn it is to write. The API derives the bucket; the screen only
 * names it, orders nothing and never infers a loss.
 */
export const INBOX_BUCKETS = Object.freeze([
  Object.freeze({
    value: 'respond',
    route: 'responder',
    label: 'Responder',
    name: 'Responder',
    order: 'Maior espera primeiro',
    emptyTitle: 'Ninguém esperando resposta',
    emptyText: 'Quando um cliente escrever, a conversa aparece aqui.',
  }),
  Object.freeze({
    value: 'awaiting',
    route: 'aguardando',
    label: 'Aguardando',
    name: 'Aguardando cliente',
    order: 'Mais recentes primeiro',
    emptyTitle: 'Nenhuma conversa aguardando o cliente',
    emptyText:
      'Depois que você ou o agente responder, a conversa espera aqui pela volta do cliente.',
  }),
  Object.freeze({
    value: 'silent',
    route: 'sem-retorno',
    label: 'Sem retorno',
    name: 'Sem retorno',
    order: 'Silêncio mais antigo primeiro',
    emptyTitle: 'Nenhum cliente sem retorno',
    emptyText:
      'Quando um cliente passar 72 horas sem responder, a conversa aparece aqui para retomar ou encerrar.',
  }),
  Object.freeze({
    value: 'lost',
    route: 'perdidos',
    label: 'Perdidos',
    name: 'Perdidos',
    order: 'Perda mais recente primeiro',
    emptyTitle: 'Nenhuma conversa perdida',
    emptyText:
      'Só aparecem aqui as conversas que alguém marcou como perdidas, com o motivo.',
  }),
]);

/** MET-06: the closed list of loss reasons, in the order they are offered. */
export const LOSS_REASONS = Object.freeze([
  Object.freeze({ value: 'preco', label: 'Preço' }),
  Object.freeze({ value: 'prazo', label: 'Prazo' }),
  Object.freeze({ value: 'concorrente', label: 'Concorrente' }),
  Object.freeze({ value: 'silencio', label: 'Silêncio do cliente' }),
  Object.freeze({ value: 'indisponivel', label: 'Indisponível' }),
  Object.freeze({ value: 'outro', label: 'Outro' }),
]);

/** @param {unknown} code */
export function lossReasonLabel(code) {
  return LOSS_REASONS.find((reason) => reason.value === code)?.label ?? 'Outro';
}

/** In Responder the wait turns into an alert after 15 business minutes. */
export const RESPOND_ALERT_MINUTES = 15;

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** @param {number} value @param {string} one @param {string} many */
function plural(value, one, many) {
  return `${value} ${value === 1 ? one : many}`;
}

/**
 * A span in whole minutes, short on screen ("8 min", "1 h 20", "2 d") and
 * spelled out for a screen reader ("1 hora e 20 minutos").
 *
 * @param {number} minutes
 * @returns {{label: string, spoken: string}}
 */
export function turnSpan(minutes) {
  const total = Math.max(0, Math.floor(Number(minutes) || 0));
  if (total < MINUTES_PER_HOUR)
    return {
      label: `${total} min`,
      spoken: plural(total, 'minuto', 'minutos'),
    };
  if (total < MINUTES_PER_DAY) {
    const hours = Math.floor(total / MINUTES_PER_HOUR);
    const rest = total % MINUTES_PER_HOUR;
    return {
      label: rest
        ? `${hours} h ${String(rest).padStart(2, '0')}`
        : `${hours} h`,
      spoken: rest
        ? `${plural(hours, 'hora', 'horas')} e ${plural(rest, 'minuto', 'minutos')}`
        : plural(hours, 'hora', 'horas'),
    };
  }
  const days = Math.floor(total / MINUTES_PER_DAY);
  return { label: `${days} d`, spoken: plural(days, 'dia', 'dias') };
}

/** Calendar minutes between an ISO instant and now; null when unknown. @param {unknown} since @param {Date} now */
export function minutesSince(since, now) {
  const start = Date.parse(String(since ?? ''));
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((now.getTime() - start) / 60_000));
}

/** "Você: " for a person of the team, "Agente: " for the assistant. @param {Record<string, any>|null|undefined} message */
export function previewAuthor(message) {
  if (message?.direction !== 'outbound') return '';
  return message.authorKind === 'assistant'
    ? `${brand.assistant.name}: `
    : 'Você: ';
}

const SAO_PAULO = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Sao_Paulo',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});
const MS_PER_DAY = 86_400_000;
/** Monday 2000-01-03 00:00, the origin of expediente-v1's index (ADR 061). */
const INDEX_ORIGIN_MS = Date.UTC(2000, 0, 3);

/** São Paulo wall clock of an instant as a UTC-based ms count. @param {Date} at */
function wallClockMs(at) {
  /** @type {Record<string, number>} */
  const parts = {};
  for (const part of SAO_PAULO.formatToParts(at))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  const subsecond = ((at.getTime() % 1000) + 1000) % 1000;
  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ) + subsecond
  );
}

/** Weekday (0 = Monday) and minute of the day of an instant, São Paulo time. @param {Date} at */
function localParts(at) {
  const offset = wallClockMs(at) - INDEX_ORIGIN_MS;
  const days = Math.floor(offset / MS_PER_DAY);
  const weeks = Math.floor(days / 7);
  return {
    weeks,
    weekday: days - weeks * 7,
    minute: (offset - days * MS_PER_DAY) / 60_000,
  };
}

/**
 * Business minutes since the index origin, with fractions: the JS twin of
 * crm.business_minute_index_v1 (migration 0061). Weeks of 2400 minutes,
 * weekdays of 480, blocks 09:00-12:00 and 13:00-18:00, no holidays.
 *
 * @param {Date} at
 */
function businessMinuteIndex(at) {
  const { weeks, weekday, minute } = localParts(at);
  const inDay =
    weekday < 5
      ? Math.min(Math.max(minute, 540), 720) -
        540 +
        Math.min(Math.max(minute, 780), 1080) -
        780
      : 0;
  return weeks * 2400 + Math.min(weekday, 5) * 480 + inDay;
}

/** @param {unknown} value @returns {Date|null} */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Is this instant inside the expediente-v1 window? @param {Date} now */
export function isBusinessTime(now) {
  const date = toDate(now);
  if (!date) return false;
  const { weekday, minute } = localParts(date);
  if (weekday >= 5) return false;
  return (minute >= 540 && minute < 720) || (minute >= 780 && minute < 1080);
}

/**
 * Whole business minutes in [from, to), rounded down like the API's integer
 * turnBusinessMinutes: the SQL difference of indexes is fractional (numeric)
 * and the delta is floored here. Zero when inverted or invalid.
 *
 * @param {string|Date} from
 * @param {Date} to
 */
export function businessMinutesBetween(from, to) {
  const start = toDate(from);
  const end = toDate(to);
  if (!start || !end || end <= start) return 0;
  return Math.max(
    0,
    Math.floor(businessMinuteIndex(end) - businessMinuteIndex(start) + 1e-9),
  );
}

/**
 * The card clock: the server's business minutes are the reference and the
 * client only projects the delta since `turnAsOf` (ADR 061).
 *
 * @param {Record<string, any>} conversation
 * @param {Date} now
 * @returns {{businessMinutes: number|null, calendarMinutes: number|null, alert: boolean, offHours: boolean, label: string, spoken: string}}
 */
export function turnClock(conversation, now) {
  const calendarMinutes = minutesSince(conversation?.turnSince, now);
  const reported = conversation?.turnBusinessMinutes;
  if (
    conversation?.bucket === 'respond' &&
    typeof reported === 'number' &&
    Number.isFinite(reported)
  ) {
    const businessMinutes =
      Math.max(0, Math.floor(reported)) +
      businessMinutesBetween(conversation.turnAsOf, now);
    const alert = businessMinutes > RESPOND_ALERT_MINUTES;
    if (calendarMinutes !== null && calendarMinutes >= MINUTES_PER_DAY) {
      const span = turnSpan(calendarMinutes);
      return {
        businessMinutes,
        calendarMinutes,
        alert,
        offHours: false,
        label: span.label,
        spoken: span.spoken,
      };
    }
    if (businessMinutes === 0 && !isBusinessTime(now))
      return {
        businessMinutes,
        calendarMinutes,
        alert,
        offHours: true,
        label: 'fora do expediente',
        spoken: 'fora do expediente',
      };
    const span = turnSpan(businessMinutes);
    return {
      businessMinutes,
      calendarMinutes,
      alert,
      offHours: false,
      label: span.label,
      spoken: `${span.spoken} de expediente`,
    };
  }
  const span = calendarMinutes === null ? null : turnSpan(calendarMinutes);
  return {
    businessMinutes: null,
    calendarMinutes,
    alert: false,
    offHours: false,
    label: span?.label ?? '',
    spoken: span?.spoken ?? '',
  };
}

/** @typedef {{key: string, label: string, tone?: 'error'|'warning'|'success'|'info'}} Badge */

const DEFAULT_BADGE_ORDER = [
  'delivery',
  'claim',
  'urgent',
  'stalled',
  'ready',
  'reminder',
  'owner',
  'lost',
];
/** The seal that must never fall into "+N" on each tab (P1-B). */
const BADGE_FIRST = { lost: 'lost', silent: 'reminder' };

/**
 * The card's seals, ordered by tab: what blocks the reply first, then what
 * helps decide, then who has it; in Perdidos the reason leads and in Sem
 * retorno the reminder leads. No seal depends on `title`.
 *
 * @param {Record<string, any>} conversation
 * @param {{bucket?: string, actorId?: string, ownerName?: string, reminderLabel?: (instant: unknown) => string}} [context]
 * @returns {Badge[]}
 */
export function conversationBadges(conversation, context = {}) {
  /** @type {Badge[]} */
  const badges = [];
  const delivery =
    conversation.deliveryIssue?.status ??
    conversation.lastMessage?.deliveryStatus;
  if (delivery === 'failed')
    badges.push({ key: 'delivery', label: 'Falha de envio', tone: 'error' });
  else if (delivery === 'outcome_unknown')
    badges.push({ key: 'delivery', label: 'Envio incerto', tone: 'warning' });
  const owner = conversation.assignedUser;
  // Assumir: no owner and waiting to be taken, either by a pending transfer
  // or as a new conversation that has no handoff yet.
  const waitingToBeTaken =
    conversation.handoff?.status === 'pending' ||
    (conversation.state === 'nova' && !conversation.handoff);
  if (waitingToBeTaken && !owner)
    badges.push({ key: 'claim', label: 'Assumir', tone: 'warning' });
  if (conversation.handoff?.reasonCode === 'urgency')
    badges.push({ key: 'urgent', label: 'Urgente', tone: 'warning' });
  if (conversation.assistantStalled === true)
    badges.push({
      key: 'stalled',
      label: `${brand.assistant.name} parou`,
      tone: 'warning',
    });
  if (orderReadyToReview(conversation))
    badges.push({ key: 'ready', label: 'Pedido pronto', tone: 'success' });
  if (owner && owner.id !== context.actorId) {
    const name = String(context.ownerName || owner.name || '').trim();
    badges.push({
      key: 'owner',
      label: name ? `Com ${name.split(/\s+/u)[0]}` : 'Com outro vendedor',
    });
  } else if (!owner && conversation.automationState !== 'assistant') {
    badges.push({ key: 'owner', label: 'Sem dono' });
  }
  if (conversation.lostOutcome)
    badges.push({
      key: 'lost',
      label: `Perdido · ${lossReasonLabel(conversation.lostOutcome.reasonCode)}`,
    });
  if (conversation.reminder?.remindAt)
    badges.push({
      key: 'reminder',
      label: context.reminderLabel
        ? `Lembrete ${context.reminderLabel(conversation.reminder.remindAt)}`
        : 'Lembrete',
      tone: 'info',
    });
  const first =
    context.bucket === 'lost' || context.bucket === 'silent'
      ? BADGE_FIRST[context.bucket]
      : null;
  const rank = (/** @type {Badge} */ badge) =>
    badge.key === first ? -1 : DEFAULT_BADGE_ORDER.indexOf(badge.key);
  return badges.sort((a, b) => rank(a) - rank(b));
}

/**
 * Seals on the card and the ones counted as "+N".
 *
 * @param {Badge[]} badges
 * @param {number} [visible]
 */
export function splitBadges(badges, visible = 2) {
  const count = Math.max(0, Math.floor(visible));
  return { shown: badges.slice(0, count), hidden: badges.slice(count) };
}

/**
 * P1-D: an API older than RFC 052 returns items without a matching bucket.
 * An empty list matches.
 *
 * @param {Array<Record<string, any>>} items
 * @param {string} bucket
 */
export function listMatchesBucket(items, bucket) {
  return (items ?? []).every((item) => item?.bucket === bucket);
}

/** MET-06/07: only the owner or an administrator records or corrects a loss. */
export const LOSS_FORBIDDEN =
  'Só o dono da conversa ou um administrador pode marcar ou corrigir a perda.';

/** The API accepts a reminder from now up to 90 days ahead (INVALID_REMINDER_DATE). */
export const REMINDER_MAX_DAYS = 90;
export const REMINDER_RANGE_MESSAGE =
  'Escolha um horário futuro, em até 90 dias.';

/**
 * Codes the loss and reminder commands answer with, in the words of the
 * screen. A code not listed falls back to the status message.
 *
 * @type {Readonly<Record<string, string>>}
 */
const TURN_COMMAND_ERRORS = Object.freeze({
  LEAD_HAS_ORDER:
    'Há pedido em aberto; encerre ou cancele o pedido antes de marcar como perdida.',
  LEAD_AWAITING_REPLY:
    'O cliente espera resposta. Responda antes de marcar como perdida.',
  LEAD_NOT_ELIGIBLE:
    'Só conversas com atendimento humano e dono podem ser marcadas ou corrigidas.',
  LEAD_ALREADY_LOST:
    'A conversa já está marcada como perdida. Os dados foram recarregados.',
  LEAD_NOT_LOST:
    'A conversa já não está marcada como perdida. Os dados foram recarregados.',
  ACTION_NOT_AVAILABLE:
    'Esta conversa foi encerrada ou arquivada e não aceita lembrete. Os dados foram recarregados.',
  INVALID_LOSS_REASON: 'Escolha o motivo da perda.',
  INVALID_LOSS_NOTE:
    'Descreva o motivo em até 140 caracteres, com texto legível.',
  INVALID_REMINDER_DATE: REMINDER_RANGE_MESSAGE,
});

/** @param {unknown} code @returns {string} empty when the code has no text of its own */
export function turnCommandError(code) {
  return TURN_COMMAND_ERRORS[String(code ?? '')] ?? '';
}

/**
 * Is this instant a valid reminder: after `now` and within 90 days?
 *
 * @param {string|null} instant ISO instant
 * @param {Date} now
 */
export function reminderInRange(instant, now) {
  const at = Date.parse(String(instant ?? ''));
  if (!Number.isFinite(at)) return false;
  return (
    at > now.getTime() && at <= now.getTime() + REMINDER_MAX_DAYS * 86_400_000
  );
}

/** @type {Map<string, string>} */
const ROUTE_BUCKETS = new Map(
  INBOX_BUCKETS.map(
    (item) => /** @type {[string, string]} */ ([item.route, item.value]),
  ),
);
const ROUTE_OWNERS = new Map([
  ['minhas', 'mine'],
  ['sem-responsavel', 'unassigned'],
]);

/**
 * `?aba=` names a tab. A Map, so `?aba=constructor` or `__proto__` is just an
 * unknown value and never a function from Object.prototype.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function bucketForRoute(value) {
  return ROUTE_BUCKETS.get(String(value ?? '')) ?? null;
}

/** `?fila=` names the owner scope. @param {unknown} value @returns {string|null} */
export function ownerForRoute(value) {
  return ROUTE_OWNERS.get(String(value ?? '')) ?? null;
}
