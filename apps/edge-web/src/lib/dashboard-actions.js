// ACT-01..12: presentation only. The API owns eligibility and every decision.
export const ACTION_FILTERS = Object.freeze([
  { key: 'all', label: 'Tudo' },
  { key: 'conversation', label: 'Conversas' },
  { key: 'order', label: 'Pedidos' },
  { key: 'deferred', label: 'Adiados' },
]);

export const ACTION_GROUPS = Object.freeze([
  { key: 'attention', label: 'Atender agora' },
  { key: 'orders', label: 'Pedidos para conferir' },
  { key: 'followup', label: 'Retomar contato' },
]);

/** @param {Record<string, any>} item */
export function actionGroup(item) {
  if (item.targetType === 'order') return 'orders';
  if (item.kind === 'followup') return 'followup';
  return 'attention';
}

/** @param {Record<string, any>[]} items @param {string} filter */
export function filterActions(items, filter) {
  return items.filter((item) => {
    if (filter === 'deferred') return item.deferred === true;
    if (item.deferred) return false;
    return (
      filter === 'all' ||
      (filter === 'order' && item.targetType === 'order') ||
      (filter === 'conversation' && item.targetType === 'conversation')
    );
  });
}

/** @param {unknown} name */
export function actionInitials(name) {
  return (
    String(name ?? '')
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toLocaleUpperCase('pt-BR') || '—'
  );
}

/** @param {unknown} value */
export function performanceCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? new Intl.NumberFormat('pt-BR').format(value)
    : '—';
}

/** @param {unknown} value */
export function performanceMoney(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      }).format(value / 100)
    : '—';
}

const WALL_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** @param {Date} instant */
function wallParts(instant) {
  return Object.fromEntries(
    WALL_CLOCK.formatToParts(instant).map(({ type, value }) => [type, value]),
  );
}

/** @param {Date} instant */
function wallEpoch(instant) {
  const p = wallParts(instant);
  return Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
}

/** A datetime-local is a São Paulo wall time, never the phone's timezone.
 * @param {string} value @returns {string|null}
 */
export function reminderInstant(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const target = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    0,
  );
  let guess = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    guess += target - wallEpoch(new Date(guess));
  }
  const p = wallParts(new Date(guess));
  if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}` !== value)
    return null;
  return new Date(guess).toISOString();
}

/** @param {string} day @param {unknown} generatedAt */
export function defaultReminder(day, generatedAt) {
  const afternoon = `${day}T15:00`;
  const instant = reminderInstant(afternoon);
  if (instant && Date.parse(instant) > Date.parse(String(generatedAt))) {
    return afternoon;
  }
  const next = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(next.getTime())) return '';
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T09:00`;
}

/** @param {unknown} instant */
export function reminderLabel(instant) {
  const date = new Date(String(instant ?? ''));
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(date);
}
