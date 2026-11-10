// PERF-01..08 and MET-02..08: the rows of the team table, by view. The API
// computes every number; a missing read becomes "—", never zero, and the
// channel rows ("Loja do site", "Sem atribuição") stay apart from people so
// the total reconciles (PERF-05).
import { performanceCount, performanceMoney } from './dashboard-actions.js';
import {
  joinPeople,
  minutesLabel,
  reasonBreakdown,
  topReason,
} from './dashboard-metrics.js';

/** @typedef {{text: string, note?: string, value?: number|null, tone?: string}} Cell */
/** @typedef {{id: string, name: string, note?: string, cells: Record<string, Cell>}} Row */

/** @param {unknown} value */
function number(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** @param {unknown} cents @returns {Cell} */
export function moneyCell(cents) {
  return { text: performanceMoney(cents), value: number(cents) };
}

/** @param {unknown} count @returns {Cell} */
export function countCell(count) {
  return { text: performanceCount(count), value: number(count) };
}

/** @param {unknown} sold @param {unknown} orders @returns {Cell} */
function ticketCell(sold, orders) {
  const cents = number(sold);
  const count = number(orders);
  if (cents === null || !count) return { text: '—', value: null };
  const ticket = Math.round(cents / count);
  return { text: performanceMoney(ticket), value: ticket };
}

/** @returns {Cell} */
const NONE = () => ({ text: '—', value: null });

/**
 * MET-04: the median as the value; p90, samples and open waits in the note.
 *
 * @param {Record<string, any>|undefined} metric
 * @returns {Cell}
 */
function timeCell(metric) {
  if (!metric) return NONE();
  const median =
    typeof metric.medianMinutes === 'number' ? metric.medianMinutes : null;
  const samples = number(metric.samples) ?? 0;
  const parts = [];
  if (samples)
    parts.push(`${samples} ${samples === 1 ? 'amostra' : 'amostras'}`);
  if (typeof metric.p90Minutes === 'number')
    parts.push(`p90 ${minutesLabel(metric.p90Minutes)}`);
  const open = number(metric.openCount) ?? 0;
  if (open) parts.push(`${open} em aberto`);
  return {
    text: minutesLabel(median),
    value: median,
    note: parts.join(' · ') || 'Sem amostras',
  };
}

/** @param {Record<string, any>} person */
function personNote(person) {
  return person.active === false ? 'Inativo' : '';
}

/**
 * Vendas: people, then "Loja do site" and "Sem atribuição", then the total.
 *
 * @param {Record<string, any>|null|undefined} performance
 * @param {{withSale?: boolean}} [options]
 */
export function salesTable(performance, { withSale = true } = {}) {
  if (!performance) return { rows: [], extraRows: [], totalRow: null };
  /** @type {Row[]} */
  const rows = (performance.rows ?? []).map(
    (/** @type {Record<string, any>} */ row) => ({
      id: String(row.userId),
      name: String(row.name ?? '').trim() || 'Pessoa sem nome',
      note: personNote(row),
      cells: {
        sold: moneyCell(row.soldAmountCents),
        orders: countCell(row.confirmedCount),
        ticket: ticketCell(row.soldAmountCents, row.confirmedCount),
        ...(withSale
          ? { withSale: countCell(row.conversationsWithSaleCount) }
          : {}),
      },
    }),
  );
  /** @param {string} id @param {string} name @param {any} value @returns {Row} */
  const channel = (id, name, value) => ({
    id,
    name,
    cells: {
      sold: moneyCell(value?.soldAmountCents),
      orders: countCell(value?.confirmedCount),
      ticket: ticketCell(value?.soldAmountCents, value?.confirmedCount),
      ...(withSale ? { withSale: NONE() } : {}),
    },
  });
  return {
    rows,
    extraRows: [
      channel('store', 'Loja do site', performance.store),
      channel('unattributed', 'Sem atribuição', performance.unattributed),
    ],
    totalRow: channel('total', 'Total', performance.totals),
  };
}

/**
 * Atendimento: activity from `/dashboard/performance` and business-hour times
 * from `/dashboard/metrics/service`, joined by person. No company total for
 * activity: one conversation can count for two people (PERF-04).
 *
 * @param {Record<string, any>|null|undefined} performance
 * @param {Record<string, any>|null|undefined} service
 */
export function serviceTable(performance, service) {
  /** @type {Row[]} */
  const rows = joinPeople(performance?.rows, service?.rows).map((person) => {
    const [activity, times] = person.sources;
    return {
      id: person.userId,
      name: person.name,
      note: person.active ? '' : 'Inativo',
      cells: {
        attended: performance
          ? countCell(activity?.attendedCount ?? 0)
          : NONE(),
        assumed: performance ? countCell(activity?.assumedCount ?? 0) : NONE(),
        closed: performance ? countCell(activity?.closedCount ?? 0) : NONE(),
        firstResponse: service ? timeCell(times?.firstResponse) : NONE(),
        claim: service ? timeCell(times?.claim) : NONE(),
        unanswered: service
          ? {
              ...countCell(times?.unansweredEpisodes?.count ?? 0),
              tone:
                (number(times?.unansweredEpisodes?.count) ?? 0) > 0
                  ? 'warning'
                  : undefined,
            }
          : NONE(),
      },
    };
  });
  const episodes = service
    ? (service.rows ?? []).reduce(
        (/** @type {number} */ sum, /** @type {any} */ row) =>
          sum + (number(row.unansweredEpisodes?.count) ?? 0),
        0,
      )
    : null;
  return { rows, episodes };
}

/**
 * Perdas (MET-06–08): declared losses by person, with the main reason; the
 * total is the API's, one conversation counted once.
 *
 * @param {Record<string, any>|null|undefined} losses
 */
export function lossTable(losses) {
  if (!losses) return { rows: [], totalRow: null, reasons: [] };
  /** @type {Row[]} */
  const rows = (losses.rows ?? []).map(
    (/** @type {Record<string, any>} */ row) => {
      return {
        id: String(row.userId),
        name: String(row.name ?? '').trim() || 'Pessoa sem nome',
        note: personNote(row),
        cells: {
          lost: countCell(row.lostCount),
          reopened: countCell(row.reopenedByCustomerCount),
          reason: { text: topReason(row.byReason), value: null },
        },
      };
    },
  );
  const totals = losses.totals;
  return {
    rows,
    totalRow: totals
      ? {
          id: 'total',
          name: 'Total',
          cells: {
            lost: countCell(totals.lostCount),
            reopened: countCell(totals.reopenedByCustomerCount),
            reason: { text: topReason(totals.byReason), value: null },
          },
        }
      : null,
    reasons: reasonBreakdown(totals?.byReason),
  };
}
