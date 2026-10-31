/**
 * AGENTE-OBS-01 (RFC 041): the words of "Desempenho do agente". The numbers
 * are aggregates of `GET /api/v1/inbox/assistant/performance`; nothing here
 * reads a conversation, a name or a message. A field the server did not send
 * (an older API) reads "—", and a measure without samples says so, never
 * "0 min", "NaN" or "null".
 */
import { brand } from '../brand/index.js';
import { snakeKeys } from './assistant-context.js';
import { handoffReasonLabel } from './order-format.js';

export const PERFORMANCE_PERIODS = Object.freeze([
  Object.freeze({ days: 7, label: '7 dias' }),
  Object.freeze({ days: 14, label: '14 dias' }),
  Object.freeze({ days: 30, label: '30 dias' }),
]);

export const DEFAULT_PERFORMANCE_DAYS = 7;

const NO_SAMPLES = 'Sem amostras no período';
const UNKNOWN = '—';

const dayFormatter = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
});
const percentFormatter = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 0,
  style: 'percent',
});
const numberFormatter = new Intl.NumberFormat('pt-BR');

/**
 * "do agente", "da assistente": the brand's reference with its article
 * joined to "de" (whitelabel, RFC 022).
 */
export function assistantOf() {
  const reference = brand.assistant.reference;
  const match = /^(o|a|os|as)\s+(.+)$/iu.exec(reference);
  return match ? `d${match[1].toLowerCase()} ${match[2]}` : `de ${reference}`;
}

/** The page title, from the brand: "Desempenho do agente". */
export function performanceTitle() {
  return `Desempenho ${assistantOf()}`;
}

/**
 * A count the server sent, or null when it is missing or not a count.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function countOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/** @param {number|null} value */
function countText(value) {
  return value === null ? UNKNOWN : numberFormatter.format(value);
}

/** @param {number} count @param {string} one @param {string} many */
function plural(count, one, many) {
  return `${numberFormatter.format(count)} ${count === 1 ? one : many}`;
}

/**
 * "menos de 1 min", "12 min", "1 h 20 min", "2 dias 3 h"; '' when there is
 * no measure.
 *
 * @param {unknown} minutes
 */
export function durationLabel(minutes) {
  if (minutes === null || minutes === undefined || minutes === '') return '';
  const value = Number(minutes);
  if (!Number.isFinite(value) || value < 0) return '';
  const total = Math.round(value);
  if (total < 1) return 'menos de 1 min';
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  const dayText = plural(days, 'dia', 'dias');
  return restHours ? `${dayText} ${restHours} h` : dayText;
}

/** "62%" for 0.62; '' outside 0..1. @param {unknown} ratio */
export function ratioLabel(ratio) {
  if (ratio === null || ratio === undefined || ratio === '') return '';
  const value = Number(ratio);
  if (!Number.isFinite(value) || value < 0 || value > 1) return '';
  return percentFormatter.format(value).replace(/\s/gu, '');
}

/** @param {unknown} value */
function dayOf(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isNaN(time) ? '' : dayFormatter.format(new Date(time));
}

/**
 * "Últimos 7 dias, de 23/10 a 30/10": the window the numbers belong to, read
 * from the answer, so a failed change of period never mislabels them.
 *
 * @param {Record<string, any>|null|undefined} window
 * @param {number} [fallbackDays]
 */
export function windowLabel(window, fallbackDays = DEFAULT_PERFORMANCE_DAYS) {
  const days = countOf(window?.days) || fallbackDays;
  const base = days === 1 ? 'Último dia' : `Últimos ${days} dias`;
  const from = dayOf(window?.from);
  const to = dayOf(window?.to);
  return from && to ? `${base}, de ${from} a ${to}` : base;
}

/**
 * @typedef {{key: string, label: string, value: string, detail: string, tone: 'warning'|null, empty?: boolean}} PerformanceMetric
 * @typedef {{code: string, label: string, count: number, share: string}} PerformanceReason
 * @typedef {{key: string, label: string, count: number|null}} PerformanceFailure
 * @typedef {{version: string, turns: number|null, handoffs: number|null, detail: string}} PerformanceVersion
 */

/** @param {Record<string, any>} data @param {number} handoffs */
function reasonsOf(data, handoffs) {
  const rows = Array.isArray(data.handoffs?.by_reason)
    ? data.handoffs.by_reason
    : [];
  /** @type {Map<string, number>} */
  const byLabel = new Map();
  for (const row of rows) {
    const count = countOf(row?.count);
    if (!count) continue;
    // Two codes may share a label ("Perguntou o valor"); they read as one.
    const label = handoffReasonLabel(row?.reason_code);
    byLabel.set(label, (byLabel.get(label) ?? 0) + count);
  }
  const total =
    handoffs || [...byLabel.values()].reduce((sum, count) => sum + count, 0);
  return [...byLabel]
    .map(([label, count]) => ({
      code: label,
      count,
      label,
      share: total ? ratioLabel(Math.min(1, count / total)) : '',
    }))
    .sort(
      (left, right) =>
        right.count - left.count || left.label.localeCompare(right.label),
    );
}

const FAILURES = Object.freeze([
  Object.freeze({
    key: 'workflow_failed',
    label: 'Execuções do workflow com erro',
  }),
  Object.freeze({ key: 'send_failed', label: 'Envios que falharam' }),
  Object.freeze({ key: 'send_unknown', label: 'Envios sem confirmação' }),
  Object.freeze({
    key: 'stale_fence',
    label: 'Respostas descartadas por chegarem tarde',
  }),
  Object.freeze({
    key: 'transcription_failed',
    label: 'Áudios sem transcrição',
  }),
  Object.freeze({
    key: 'automation_failure_handoffs',
    label: 'Transferências porque o agente falhou',
  }),
]);

/** @param {Record<string, any>} data @returns {PerformanceFailure[]} */
function failuresOf(data) {
  const failures =
    data.failures && typeof data.failures === 'object' ? data.failures : {};
  return FAILURES.map(({ key, label }) => ({
    count: countOf(failures[key]),
    key,
    label,
  }));
}

/** @param {Record<string, any>} data @returns {PerformanceVersion[]} */
function versionsOf(data) {
  const rows = Array.isArray(data.by_workflow_version)
    ? data.by_workflow_version
    : [];
  return rows
    .filter(
      (row) =>
        typeof row?.workflow_version === 'string' &&
        /^[A-Za-z0-9._-]{1,64}$/u.test(row.workflow_version),
    )
    .map((row) => {
      const turns = countOf(row.turns);
      const handoffs = countOf(row.handoffs);
      return {
        detail: [
          turns === null ? '' : plural(turns, 'turno', 'turnos'),
          handoffs === null
            ? ''
            : plural(handoffs, 'transferência', 'transferências'),
        ]
          .filter(Boolean)
          .join(' · '),
        handoffs,
        turns,
        version: row.workflow_version,
      };
    });
}

/** "(9 transferências)", or '' without samples. @param {unknown} samples @param {string} one @param {string} many */
function samplesOf(samples, one, many) {
  const count = countOf(samples);
  return count ? ` (${plural(count, one, many)})` : '';
}

/** @param {Record<string, any>} data @returns {PerformanceMetric[]} */
function timingOf(data) {
  const ficha = data.ficha_at_handoff ?? {};
  const fichaSamples = countOf(ficha.samples);
  const fichaValue = fichaSamples ? ratioLabel(ficha.avg_ratio) : '';
  const claim = data.time_to_claim_minutes ?? {};
  const claimSamples = countOf(claim.samples);
  const claimMedian = claimSamples ? durationLabel(claim.median) : '';
  const claimP90 = claimSamples ? durationLabel(claim.p90) : '';
  const resolve = data.time_to_resolve_minutes ?? {};
  const resolveSamples = countOf(resolve.samples);
  const resolveMedian = resolveSamples ? durationLabel(resolve.median) : '';
  return [
    {
      detail: fichaValue
        ? `Média da ficha preenchida ao transferir${samplesOf(fichaSamples, 'transferência', 'transferências')}`
        : '',
      empty: !fichaValue,
      key: 'ficha',
      label: 'Ficha na transferência',
      tone: null,
      value: fichaValue || NO_SAMPLES,
    },
    {
      // The median is the value; the 90th percentile says how long the
      // slowest ones waited, in words a manager reads.
      detail: claimMedian
        ? `Metade foi assumida em até ${claimMedian}${claimP90 ? `; 9 em cada 10, em até ${claimP90}` : ''}${samplesOf(claimSamples, 'transferência', 'transferências')}`
        : '',
      empty: !claimMedian,
      key: 'claim',
      label: 'Tempo até assumir',
      tone: null,
      value: claimMedian || NO_SAMPLES,
    },
    {
      detail: resolveMedian
        ? `Metade foi encerrada em até ${resolveMedian}${samplesOf(resolveSamples, 'conversa', 'conversas')}`
        : '',
      empty: !resolveMedian,
      key: 'resolve',
      label: 'Tempo até resolver',
      tone: null,
      value: resolveMedian || NO_SAMPLES,
    },
  ];
}

/**
 * @typedef {{
 *   windowLabel: string,
 *   empty: boolean,
 *   totals: PerformanceMetric[],
 *   reasons: PerformanceReason[],
 *   timing: PerformanceMetric[],
 *   failures: PerformanceFailure[],
 *   failureTotal: number|null,
 *   versions: PerformanceVersion[],
 * }} PerformanceSummary
 */

/**
 * The page, from one answer of the API.
 *
 * @param {Record<string, any>|null|undefined} answer
 * @param {number} [requestedDays]
 * @returns {PerformanceSummary}
 */
export function performanceSummary(answer, requestedDays) {
  const data = answer && typeof answer === 'object' ? snakeKeys(answer) : {};
  const conversations = countOf(data.conversations_with_assistant);
  const replies = countOf(data.assistant_replies);
  const handoffs = countOf(data.handoffs?.total);
  const stalled = countOf(data.stalled_now);
  const failures = failuresOf(data);
  const known = failures.filter((failure) => failure.count !== null);
  return {
    empty: !conversations && !replies && !handoffs,
    failureTotal: known.length
      ? known.reduce((sum, failure) => sum + Number(failure.count), 0)
      : null,
    failures,
    reasons: reasonsOf(data, handoffs ?? 0),
    timing: timingOf(data),
    totals: [
      {
        detail: 'Atendidas no período',
        key: 'conversations',
        label: `Conversas com ${brand.assistant.reference}`,
        tone: null,
        value: countText(conversations),
      },
      {
        detail: 'Mensagens enviadas ao cliente',
        key: 'replies',
        label: 'Respostas',
        tone: null,
        value: countText(replies),
      },
      {
        detail: 'Conversas passadas para uma pessoa',
        key: 'handoffs',
        label: 'Transferências',
        tone: null,
        value: countText(handoffs),
      },
      {
        detail:
          stalled === null
            ? 'Sem dados agora'
            : stalled
              ? 'Cliente esperando resposta agora'
              : 'Nenhuma conversa parada agora',
        key: 'stalled',
        label: 'Paradas agora',
        tone: stalled ? 'warning' : null,
        value: countText(stalled),
      },
    ],
    versions: versionsOf(data),
    windowLabel: windowLabel(data.window, requestedDays),
  };
}

/** @param {unknown} days */
export function performanceDays(days) {
  const value = Number(days);
  return PERFORMANCE_PERIODS.some((period) => period.days === value)
    ? value
    : DEFAULT_PERFORMANCE_DAYS;
}
