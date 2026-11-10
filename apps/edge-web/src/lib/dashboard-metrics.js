// MET-01..08 / PERF-01..08 (RFC 048, ADR 061): presentation only. The API
// computes every number; here we only pick words, join rows by person and
// keep "no data" distinct from zero. The loss reasons and their labels are
// the Inbox's (`inbox-turn.js`), where a loss is declared (MET-06).
import { LOSS_REASONS } from './inbox-turn.js';

/**
 * MET-04: business minutes, one decimal from the API. Null is "—", never 0.
 *
 * @param {unknown} value
 */
export function minutesLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    return '—';
  if (value < 1) return 'menos de 1 min';
  const rounded = Math.round(value);
  if (rounded < 60) return `${rounded} min`;
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

const WEEKDAY_NAMES = Object.freeze([
  '',
  'segunda',
  'terça',
  'quarta',
  'quinta',
  'sexta',
  'sábado',
  'domingo',
]);

/** "09:00" → "9h", "12:30" → "12h30". @param {string} value */
function clockLabel(value) {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return value;
  const hour = String(Number(match[1]));
  return match[2] === '00' ? `${hour}h` : `${hour}h${match[2]}`;
}

/**
 * MET-01: the policy as the API states it, so the screen never restates a
 * schedule the server does not use.
 *
 * @param {Record<string, any>|null|undefined} businessHours
 */
export function businessHoursLabel(businessHours) {
  const weekdays = Array.isArray(businessHours?.weekdays)
    ? businessHours.weekdays.map(Number).filter((day) => day >= 1 && day <= 7)
    : [];
  const blocks = Array.isArray(businessHours?.blocks)
    ? businessHours.blocks.filter(
        (/** @type {unknown} */ block) =>
          Array.isArray(block) && block.length === 2,
      )
    : [];
  if (!weekdays.length || !blocks.length)
    return 'no horário de expediente da empresa';
  const sorted = [...weekdays].sort((a, b) => a - b);
  const contiguous = sorted.every(
    (day, index) => index === 0 || day === sorted[index - 1] + 1,
  );
  const days =
    sorted.length === 1
      ? WEEKDAY_NAMES[sorted[0]]
      : contiguous
        ? `${WEEKDAY_NAMES[sorted[0]]} a ${WEEKDAY_NAMES[sorted.at(-1) ?? 0]}`
        : sorted.map((day) => WEEKDAY_NAMES[day]).join(', ');
  const hours = blocks
    .map(
      (/** @type {string[]} */ [from, to]) =>
        `${clockLabel(String(from))}–${clockLabel(String(to))}`,
    )
    .join(' e ');
  return `de ${days}, ${hours}, horário de São Paulo`;
}

/** @param {unknown} value */
function safeCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * MET-05, retrato de agora: conversations past 15 business minutes, by
 * person, largest first. Null when the read failed (shown as "—").
 *
 * @param {Record<string, any>|null|undefined} service
 * @returns {{count: number, people: {userId: string, name: string, count: number}[]}|null}
 */
export function unansweredNow(service) {
  if (!service || !Array.isArray(service.rows)) return null;
  const people = service.rows
    .map((/** @type {Record<string, any>} */ row) => ({
      userId: String(row.userId ?? ''),
      name: personName(row.name),
      count: safeCount(row.unansweredNow?.count) ?? 0,
    }))
    .filter((person) => person.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
  return {
    count: people.reduce((sum, person) => sum + person.count, 0),
    people,
  };
}

/** @param {unknown} name */
export function personName(name) {
  const text = String(name ?? '').trim();
  return text || 'Pessoa sem nome';
}

/**
 * "3 de Bruno T. · 1 de Pedro M." (at most `limit` people, then "e mais N").
 *
 * @param {{name: string, count: number}[]} people @param {number} [limit]
 */
export function peopleBreakdown(people, limit = 2) {
  const shown = people
    .slice(0, limit)
    .map((person) => `${person.count} de ${person.name}`);
  const rest = people.length - limit;
  if (rest > 0) shown.push(`mais ${rest} ${rest === 1 ? 'pessoa' : 'pessoas'}`);
  return shown.join(' · ');
}

/**
 * PERF-05: the people, the channel rows and the total; `difference` is what
 * the rows do not explain (0 when the sum reconciles), never hidden.
 *
 * @param {Record<string, any>|null|undefined} performance
 */
export function salesReconciliation(performance) {
  const amount = (/** @type {any} */ value) =>
    safeCount(value?.soldAmountCents) ?? 0;
  const orders = (/** @type {any} */ value) =>
    safeCount(value?.confirmedCount) ?? 0;
  const rows = Array.isArray(performance?.rows) ? performance.rows : [];
  const explained =
    rows.reduce(
      (/** @type {number} */ sum, /** @type {any} */ row) => sum + amount(row),
      0,
    ) +
    amount(performance?.store) +
    amount(performance?.unattributed);
  const explainedOrders =
    rows.reduce(
      (/** @type {number} */ sum, /** @type {any} */ row) => sum + orders(row),
      0,
    ) +
    orders(performance?.store) +
    orders(performance?.unattributed);
  return {
    difference: amount(performance?.totals) - explained,
    orderDifference: orders(performance?.totals) - explainedOrders,
  };
}

/**
 * Joins the person rows of several reads by `userId`, preserving the first
 * read's order (the API's) and appending people that only appear later.
 *
 * @param {...(Record<string, any>[]|undefined|null)} lists
 * @returns {{userId: string, name: string, active: boolean, sources: Record<string, any>[]}[]}
 */
export function joinPeople(...lists) {
  /** @type {Map<string, {userId: string, name: string, active: boolean, sources: Record<string, any>[]}>} */
  const people = new Map();
  lists.forEach((list, index) => {
    for (const row of Array.isArray(list) ? list : []) {
      const userId = String(row?.userId ?? '');
      if (!userId) continue;
      const person = people.get(userId) ?? {
        userId,
        name: personName(row.name),
        active: row.active !== false,
        sources: [],
      };
      if (row.name && person.name === 'Pessoa sem nome')
        person.name = personName(row.name);
      if (row.active === false) person.active = false;
      person.sources[index] = row;
      people.set(userId, person);
    }
  });
  return [...people.values()];
}

/**
 * MET-08: the reasons of the period, largest first, with the share of the
 * largest for a decorative meter. Zero reasons stay out of the list.
 *
 * @param {Record<string, any>|null|undefined} byReason
 */
export function reasonBreakdown(byReason) {
  const items = LOSS_REASONS.map((reason) => ({
    code: reason.value,
    label: reason.label,
    count: safeCount(byReason?.[reason.value]) ?? 0,
  })).filter((reason) => reason.count > 0);
  const largest = Math.max(0, ...items.map((item) => item.count));
  return items
    .sort((a, b) => b.count - a.count)
    .map((item) => ({
      ...item,
      share: largest ? Math.round((item.count / largest) * 100) : 0,
    }));
}

/** @param {Record<string, any>|null|undefined} byReason */
export function topReason(byReason) {
  const [first] = reasonBreakdown(byReason);
  return first ? `${first.label} (${first.count})` : '—';
}
